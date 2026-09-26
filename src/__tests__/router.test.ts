import { describe, it, expect } from '@jest/globals';
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../router/config.js';
import { assessComplexity, parseTierHint, scoreComplexity } from '../router/complexity.js';
import { classifyFailure, parseAgyErrorLine, parseResetMs } from '../router/error-classifier.js';
import { ModelHealth, formatDuration } from '../router/model-health.js';
import { ModelRouter } from '../router/router.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 3_600_000;
// exact text captured from `agy` for a Gemini model whose quota was exhausted
const QUOTA_TEXT =
  'API error (attempt 4): RESOURCE_EXHAUSTED (code 429): Individual quota reached. ' +
  'Please upgrade your subscription to increase your limits. Resets in 98h29m44s.';
// exact stderr captured for GPT-OSS when the server had no capacity
const CAPACITY_STDERR =
  'error: Our servers are experiencing high traffic right now, please try again in a minute. ' +
  '(UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server)\n' +
  'AGY_ERROR: {"short_error":"UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server","status":"UNAVAILABLE","error_code":503,"code_kind":"http","retryable":true,"error_id":"x"}';

function makeRouter(overrides: Partial<RouterConfig> = {}) {
  const clock = { t: 1_000_000_000_000 };
  const cfg: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, healthFile: null, ...overrides };
  const health = new ModelHealth(null, () => clock.t);
  return { router: new ModelRouter(cfg, health), health, clock, cfg };
}

describe('error classification', () => {
  it('parses the real "Resets in 98h29m44s" quota message', () => {
    expect(parseResetMs(QUOTA_TEXT)).toBe((98 * 60 + 29) * 60_000 + 44_000);
  });

  it('parses other reset phrasings', () => {
    expect(parseResetMs('try again in 4 hours')).toBe(4 * HOUR);
    expect(parseResetMs('Retry after 30 seconds')).toBe(30_000);
    expect(parseResetMs('please try again in a minute')).toBe(60_000);
    const now = Date.parse('2026-09-19T00:00:00Z');
    expect(parseResetMs('quota resets at 2026-09-19T05:00:00Z', now)).toBe(5 * HOUR);
    expect(parseResetMs('something unrelated')).toBeUndefined();
  });

  it('classifies the real Gemini quota result as a limit with a reset time', () => {
    const f = classifyFailure({ error: QUOTA_TEXT });
    expect(f.kind).toBe('limit');
    expect(f.code).toBe(429);
    expect(f.status).toBe('RESOURCE_EXHAUSTED');
    expect(f.resetMs).toBeGreaterThan(98 * HOUR);
  });

  it('classifies the real GPT-OSS 503 as transient capacity, not a quota limit', () => {
    expect(parseAgyErrorLine(CAPACITY_STDERR)?.error_code).toBe(503);
    const f = classifyFailure({ stderr: CAPACITY_STDERR });
    expect(f.kind).toBe('capacity');
    expect(f.resetMs).toBe(60_000);
  });

  it('falls back to text patterns and recognizes auth and stalls', () => {
    expect(classifyFailure({ error: 'You have hit the rate limit' }).kind).toBe('limit');
    expect(classifyFailure({ error: 'You are not logged into Antigravity.' }).kind).toBe('auth');
    expect(classifyFailure({ error: 'Something exploded' }).kind).toBe('other');
    expect(classifyFailure({ stalled: true, error: 'no output' }).kind).toBe('stall');
  });
});

describe('complexity scoring', () => {
  const cfg = DEFAULT_ROUTER_CONFIG;

  it('keeps routine work on tier 0', () => {
    expect(scoreComplexity('Fix the typo in README', cfg).tier).toBe(0);
    expect(scoreComplexity('Reply with exactly the word: pong', cfg).tier).toBe(0);
    expect(scoreComplexity('rename the variable foo to bar in utils.ts', cfg).tier).toBe(0);
  });

  it('escalates architecture and multi-task work', () => {
    const arch = scoreComplexity(
      'Design the architecture for a distributed job queue. Compare the trade-offs between at-least-once and exactly-once delivery, ' +
        'and handle concurrency and race conditions across workers.',
      cfg,
    );
    expect(arch.tier).toBe(2);
    const plan = scoreComplexity('You are the Lead Architect. Deconstruct the prompt; return a PlanContract with tasks.', cfg);
    expect(plan.tier).toBeGreaterThanOrEqual(1);
    expect(plan.reasons.join(' ')).toContain('plan decomposition');
  });

  it('counts list items, stack traces and referenced files', () => {
    const list = '1. parse input\n2. validate it\n3. store results\n4. emit events\n5. add metrics\n6. write docs\n';
    expect(scoreComplexity(list, cfg).reasons.join(' ')).toContain('list items');
    const multiFile = scoreComplexity('Update these to use the new API. '.repeat(10), cfg, { resourceCount: 9 });
    expect(multiFile.reasons.join(' ')).toContain('9 files referenced');
  });

  it('lets an explicit hint override the heuristic', () => {
    expect(parseTierHint({ agyRouter: { tier: 'high' } })).toBe(2);
    expect(parseTierHint({ agyRouter: { tier: 0 } })).toBe(0);
    expect(parseTierHint({ tier: 'mid' })).toBe(1);
    expect(parseTierHint({ agyRouter: { tier: 'bogus' } })).toBeUndefined();
    expect(parseTierHint(undefined)).toBeUndefined();
    const c = assessComplexity('Design the architecture', { agyRouter: { tier: 0 } }, cfg);
    expect(c.tier).toBe(0);
    expect(c.source).toBe('hint');
  });
});

describe('ModelHealth', () => {
  it('blocks with the provider-stated reset (plus a buffer) and unblocks afterwards', () => {
    const { health, clock, cfg } = makeRouter();
    const ms = health.block('gemini-3.1-pro-high', classifyFailure({ error: QUOTA_TEXT }), cfg);
    expect(ms).toBeGreaterThan(98 * HOUR);
    expect(health.blockedFor('gemini-3.1-pro-high')).toBe(ms);
    clock.t += ms + 1;
    expect(health.blockedFor('gemini-3.1-pro-high')).toBe(0);
  });

  it('uses short cooldowns for capacity and stalls and never blocks on unknown errors', () => {
    const { health, cfg } = makeRouter();
    expect(health.block('gpt-oss-120b-medium', { kind: 'capacity', message: 'no capacity' }, cfg)).toBe(cfg.cooldowns.capacityMs);
    expect(health.block('m2', { kind: 'stall', message: 'stalled' }, cfg)).toBe(cfg.cooldowns.stallMs);
    expect(health.block('m3', { kind: 'other', message: 'weird' }, cfg)).toBe(0);
    expect(health.blockedFor('m3')).toBe(0);
  });

  it('escalates 5h -> 24h -> 7d when a limit without a reset time keeps recurring', () => {
    const { health, clock, cfg } = makeRouter();
    const limit = { kind: 'limit' as const, message: 'rate limited' };
    const first = health.block('m', limit, cfg);
    expect(first).toBe(5 * HOUR);
    clock.t += first + 1;
    const second = health.block('m', limit, cfg);
    expect(second).toBe(24 * HOUR);
    clock.t += second + 1;
    expect(health.block('m', limit, cfg)).toBe(7 * 24 * HOUR);
  });

  it('remembers state across restarts and records successes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'router-')), 'health.json');
    const clock = { t: 5_000 };
    const cfg = { ...DEFAULT_ROUTER_CONFIG, healthFile: file };
    const a = new ModelHealth(file, () => clock.t);
    a.block('gemini-3.8-flash-low', classifyFailure({ error: QUOTA_TEXT }), cfg);
    a.clear('claude-sonnet-4-6');
    expect(JSON.parse(readFileSync(file, 'utf8')).entries['gemini-3.8-flash-low']).toBeDefined();

    const b = new ModelHealth(file, () => clock.t + 1000);
    expect(b.blockedFor('gemini-3.8-flash-low')).toBeGreaterThan(90 * HOUR);
    expect(b.lastSuccessAt('claude-sonnet-4-6')).toBe(5_000);
    b.clear('gemini-3.8-flash-low');
    expect(b.blockedFor('gemini-3.8-flash-low')).toBe(0);
  });

  it('formats durations', () => {
    expect(formatDuration(98 * HOUR + 29 * 60_000)).toBe('4d2h');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(30_000)).toBe('30s');
  });
});

describe('ModelRouter', () => {
  it('starts on the cheapest model for simple work', () => {
    const { router } = makeRouter();
    const d = router.decide('Fix the typo in README', undefined);
    expect(d.tier).toBe(0);
    expect(d.candidates[0]).toBe('gemini-3.8-flash-low');
  });

  it('routes complex work to the strongest available model', () => {
    const { router } = makeRouter();
    const d = router.decide('anything', { agyRouter: { tier: 2 } });
    expect(d.candidates.slice(0, 2)).toEqual(['gemini-3.1-pro-high', 'claude-opus-4-6-thinking']);
  });

  it('skips blocked models: with Gemini out, simple work goes to GPT-OSS and complex work to Opus', () => {
    const { router, cfg } = makeRouter();
    for (const m of ['gemini-3.8-flash-low', 'gemini-3.7-flash-low', 'gemini-3.6-flash-low', 'gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'gemini-3.1-pro-high']) {
      router.health.block(m, { kind: 'limit', message: 'quota', resetMs: 98 * HOUR }, cfg);
    }
    expect(router.decide('Fix the typo', undefined).candidates[0]).toBe('gpt-oss-120b-medium');
    expect(router.decide('x', { tier: 1 }).candidates[0]).toBe('gpt-oss-120b-medium');
    expect(router.decide('x', { tier: 2 }).candidates[0]).toBe('claude-opus-4-6-thinking');
  });

  it('never routes below the highest tier a conversation has needed', () => {
    const { router } = makeRouter();
    expect(router.decide('Fix the typo', undefined, 2).tier).toBe(2);
  });

  it('marks unrelated-quota siblings as suspect after a long limit, but spares recent successes', () => {
    const { router, health, clock, cfg } = makeRouter();
    health.clear('gemini-3.6-flash-low'); // worked just now, so it has its own quota
    clock.t += 1000;
    router.recordFailure('gemini-3.1-pro-high', { kind: 'limit', message: QUOTA_TEXT, resetMs: 98 * HOUR });
    expect(health.blockedFor('gemini-3.1-pro-high')).toBeGreaterThan(98 * HOUR);
    expect(health.get('gemini-3.8-flash-low')?.soft).toBe(true);
    expect(health.blockedFor('gemini-3.8-flash-low')).toBe(cfg.cooldowns.suspectMs[0]);
    expect(health.blockedFor('gemini-3.6-flash-low')).toBe(0);
    expect(health.blockedFor('claude-sonnet-4-6')).toBe(0); // other families untouched
  });

  it('treats Claude and GPT-OSS as one shared budget', () => {
    const { router, health } = makeRouter();
    router.recordFailure('claude-sonnet-4-6', { kind: 'limit', message: 'Resets in 4h5m54s', resetMs: (4 * 60 + 6) * 60_000 });
    expect(health.get('gpt-oss-120b-medium')?.soft).toBe(true);
    expect(health.get('claude-opus-4-6-thinking')?.soft).toBe(true);
    expect(health.get('gemini-3.8-flash-low')).toBeUndefined(); // a different bucket
  });

  it('does not treat a short capacity blip as a shared quota problem', () => {
    const { router, health } = makeRouter();
    router.recordFailure('gpt-oss-120b-medium', { kind: 'capacity', message: 'no capacity', resetMs: 60_000 });
    expect(health.blockedFor('gpt-oss-120b-medium')).toBeGreaterThan(0);
    expect(health.get('claude-sonnet-4-6')).toBeUndefined();
  });

  it('reports why every model is unavailable', () => {
    const { router, cfg } = makeRouter({ tiers: { 0: ['a'], 1: ['a'], 2: ['a'] } });
    router.health.block('a', { kind: 'limit', message: 'quota exhausted', resetMs: 5 * HOUR }, cfg);
    const d = router.decide('x', undefined);
    expect(d.candidates).toEqual([]);
    expect(router.describeExhausted(d)).toContain('a: unavailable for');
  });
});
