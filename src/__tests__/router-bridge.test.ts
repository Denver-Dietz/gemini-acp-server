import { describe, it, expect, jest } from '@jest/globals';
import { AcpBridge, type ClientConnection } from '../acp-bridge.js';
import type { AgyRunner, RunTurnResult } from '../agy-process.js';
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from '../router/config.js';
import { ModelHealth } from '../router/model-health.js';
import { ModelRouter } from '../router/router.js';
import type { AgyStreamEvent, SpawnTurnOptions } from '../types.js';

const HOUR = 3_600_000;
const QUOTA =
  'API error (attempt 4): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 98h29m44s.';
const CAPACITY =
  'Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server)';

type Emit = (e: AgyStreamEvent) => void | Promise<void>;
type Behavior = (opts: SpawnTurnOptions, emit: Emit) => Promise<Partial<RunTurnResult>>;

const base = (o: Partial<RunTurnResult>): RunTurnResult => ({
  exitCode: 0, stalled: false, errorAborted: false, stderr: '', ...o,
});

const text = (t: string): AgyStreamEvent => ({
  event: 'step_update',
  step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: t },
});

const succeed = (answer: string): Behavior => async (_o, emit) => {
  await emit(text(answer));
  return { conversationId: 'c1', result: { conversation_id: 'c1', status: 'SUCCESS', response: answer } };
};
const failWith = (error: string, stderr = ''): Behavior => async () => ({
  conversationId: 'c1', exitCode: 3, stderr, result: { conversation_id: 'c1', status: 'ERROR', error },
});
const stall: Behavior = async () => ({ stalled: true });
const partialThenError: Behavior = async (_o, emit) => {
  await emit(text('half an answ'));
  return { conversationId: 'c1', result: { conversation_id: 'c1', status: 'ERROR', error: QUOTA } };
};

function setup(script: Record<string, Behavior>, cfgOverrides: Partial<RouterConfig> = {}) {
  const clock = { t: 1_000_000_000_000 };
  const cfg: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, healthFile: null, ...cfgOverrides };
  const health = new ModelHealth(null, () => clock.t);
  const router = new ModelRouter(cfg, health);
  const calls: SpawnTurnOptions[] = [];
  const runner = {
    runTurn: jest.fn((opts: SpawnTurnOptions, onEvent: Emit) => {
      calls.push(opts);
      const promise = (async () => {
        const behavior = script[opts.model ?? ''];
        if (!behavior) throw new Error(`unscripted model ${opts.model}`);
        return base(await behavior(opts, onEvent));
      })();
      return { promise, abort: () => {} };
    }),
  } as unknown as AgyRunner;
  const notes: string[] = [];
  const answers: string[] = [];
  const cx: ClientConnection = {
    notify: async (_m, params: any) => {
      const u = params.update;
      if (u.sessionUpdate === 'agent_thought_chunk') notes.push(u.content.text);
      if (u.sessionUpdate === 'agent_message_chunk') answers.push(u.content.text);
    },
    request: async () => ({}),
  };
  const bridge = new AcpBridge(runner, { router, conversational: false, contextTrimming: false, mcpGating: false });
  const ask = async (prompt: string, meta?: unknown, sessionId?: string) => {
    const sid = sessionId ?? (await bridge.newSession({ cwd: '/w' })).sessionId;
    const result = await bridge.prompt({ sessionId: sid, prompt: [{ type: 'text', text: prompt }], _meta: meta }, cx);
    return { sid, result };
  };
  return { bridge, router, health, clock, calls, notes, answers, ask, cfg };
}

const models = (calls: SpawnTurnOptions[]) => calls.map((c) => c.model);

describe('AcpBridge routing and fallthrough', () => {
  it('runs simple work on the cheapest model with no fallback noise', async () => {
    const t = setup({ 'gemini-3.8-flash-low': succeed('done') });
    const { result } = await t.ask('Fix the typo in README');
    expect(result.stopReason).toBe('end_turn');
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low']);
    // agy rejects --effort next to a model whose name encodes effort (and for Claude models): never send it when routing
    expect(t.calls[0]?.effort).toBeUndefined();
    expect(t.answers.join('')).toBe('done');
    expect(t.notes.join('')).toContain('tier 0');
    expect(t.notes.join('')).not.toContain('fallback');
  });

  it('falls through from an exhausted Gemini model straight to GPT-OSS, skipping suspect Gemini siblings', async () => {
    const t = setup({
      'gemini-3.8-flash-low': failWith(QUOTA),
      'gpt-oss-120b-medium': succeed('from gpt-oss'),
    });
    const { result } = await t.ask('Fix the typo in README');
    expect(result.stopReason).toBe('end_turn');
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low', 'gpt-oss-120b-medium']); // 3.7/3.6 not wasted on
    expect(t.answers.join('')).toBe('from gpt-oss');
    expect(t.notes.join('')).toContain('gemini-3.8-flash-low failed (limit');
    expect(t.notes.join('')).toContain('(fallback)');
    expect(t.health.blockedFor('gemini-3.8-flash-low')).toBeGreaterThan(98 * HOUR);
  });

  it('remembers the limit: the next turn goes directly to the fallback without touching Gemini', async () => {
    const t = setup({ 'gemini-3.8-flash-low': failWith(QUOTA), 'gpt-oss-120b-medium': succeed('ok') });
    await t.ask('Fix the typo in README');
    t.calls.length = 0;
    await t.ask('Fix another typo');
    expect(models(t.calls)).toEqual(['gpt-oss-120b-medium']);
  });

  it('treats a 503 capacity blip as short-lived and retries the model after the cooldown', async () => {
    const script: Record<string, Behavior> = {
      'gemini-3.8-flash-low': failWith(QUOTA),
      'gpt-oss-120b-medium': failWith(CAPACITY),
      'claude-sonnet-4-6': succeed('sonnet'),
    };
    const t = setup(script);
    await t.ask('Fix the typo in README');
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low', 'gpt-oss-120b-medium', 'claude-sonnet-4-6']);
    expect(t.health.blockedFor('gpt-oss-120b-medium')).toBe(t.cfg.cooldowns.capacityMs);

    script['gpt-oss-120b-medium'] = succeed('gpt-oss again');
    t.clock.t += t.cfg.cooldowns.capacityMs + 1;
    t.calls.length = 0;
    await t.ask('Fix a third typo');
    expect(models(t.calls)).toEqual(['gpt-oss-120b-medium']);
    expect(t.health.get('gpt-oss-120b-medium')).toBeUndefined(); // success cleared the block
  });

  it('treats a silent stall like a failure and moves on', async () => {
    const t = setup({ 'gemini-3.8-flash-low': stall, 'gemini-3.7-flash-low': succeed('second') });
    await t.ask('Fix the typo in README');
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low', 'gemini-3.7-flash-low']);
    expect(t.health.blockedFor('gemini-3.8-flash-low')).toBe(t.cfg.cooldowns.stallMs);
    expect(t.calls[0]?.stallMs).toBe(t.cfg.stallTimeoutMs);
  });

  it('does not replay a turn whose output already reached the client', async () => {
    const t = setup({ 'gemini-3.8-flash-low': partialThenError, 'gpt-oss-120b-medium': succeed('never') });
    await expect(t.ask('Fix the typo in README')).rejects.toThrow(/failed mid-turn/);
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low']);
    expect(t.health.blockedFor('gemini-3.8-flash-low')).toBeGreaterThan(0); // still marked for the next turn
  });

  it('reports every blocked model when nothing is available instead of hanging', async () => {
    const cfg = { tiers: { 0: ['a', 'b'], 1: ['a', 'b'], 2: ['a', 'b'] } as RouterConfig['tiers'] };
    const t = setup({ a: failWith(QUOTA), b: failWith(QUOTA) }, cfg);
    await expect(t.ask('Fix the typo')).rejects.toThrow(/All candidate models are currently unavailable/);
    await expect(t.ask('Fix another')).rejects.toThrow(/a: unavailable for/); // fails fast: no agy call
    expect(t.calls.length).toBe(2);
  });

  it('does not burn the ladder on an auth problem', async () => {
    const t = setup({ 'gemini-3.8-flash-low': failWith('You are not logged into Antigravity.'), 'gpt-oss-120b-medium': succeed('x') });
    await expect(t.ask('Fix the typo')).rejects.toThrow(/not logged into/);
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low']);
  });

  it('falls through on an unknown error once without blocking the model', async () => {
    const t = setup({ 'gemini-3.8-flash-low': failWith('weird internal problem'), 'gemini-3.7-flash-low': succeed('ok') });
    await t.ask('Fix the typo');
    expect(models(t.calls)).toEqual(['gemini-3.8-flash-low', 'gemini-3.7-flash-low']);
    expect(t.health.blockedFor('gemini-3.8-flash-low')).toBe(0);
  });

  it('escalates by hint or heuristic and keeps the conversation at that tier', async () => {
    const t = setup({
      'gemini-3.1-pro-high': succeed('deep'),
      'gemini-3.8-flash-low': succeed('quick'),
    });
    const first = await t.ask('anything', { agyRouter: { tier: 'high' } });
    expect(models(t.calls)).toEqual(['gemini-3.1-pro-high']);
    await t.ask('Fix the typo in README', undefined, first.sid); // same session: sticky
    expect(models(t.calls)).toEqual(['gemini-3.1-pro-high', 'gemini-3.1-pro-high']);
    await t.ask('Fix the typo in README'); // brand-new session starts cheap again
    expect(models(t.calls)[2]).toBe('gemini-3.8-flash-low');
  });

  it('uses a session-level tier hint from session/new metadata', async () => {
    const t = setup({ 'claude-opus-4-6-thinking': succeed('opus') }, { tiers: { 0: ['claude-opus-4-6-thinking'], 1: ['claude-opus-4-6-thinking'], 2: ['claude-opus-4-6-thinking'] } });
    const { sessionId } = await t.bridge.newSession({ cwd: '/w', _meta: { agyRouter: { tier: 2 } } });
    await t.ask('Fix the typo', undefined, sessionId);
    expect(t.notes.join('')).toContain('tier 2');
  });

  it('retests a previously failed model with an early-abort budget and re-blocks it without waiting', async () => {
    const script: Record<string, Behavior> = {
      'gemini-3.8-flash-low': failWith(QUOTA),
      'gemini-3.7-flash-low': async (o) => (o.maxErrorSteps ? { errorAborted: true } : failWith(QUOTA)(o, () => {}) as any),
      'gpt-oss-120b-medium': succeed('ok'),
    };
    const t = setup(script, { cooldowns: { ...DEFAULT_ROUTER_CONFIG.cooldowns, suspectMs: [1000, 2000, 3000, 4000] } });
    await t.ask('Fix the typo'); // flash-low quota -> 3.7/3.6 become suspect (1s) -> gpt-oss
    t.clock.t += 1500;           // suspect window passes
    t.calls.length = 0;
    await t.ask('Fix another typo');
    const retest = t.calls.find((c) => c.model === 'gemini-3.7-flash-low');
    expect(retest?.maxErrorSteps).toBe(t.cfg.retestMaxErrorSteps);
    expect(models(t.calls).at(-1)).toBe('gpt-oss-120b-medium');
    expect(t.health.blockedFor('gemini-3.7-flash-low')).toBeGreaterThan(0);
  });
});

describe('AcpBridge with a pinned model (router off)', () => {
  it('passes the pinned model through and surfaces agy errors instead of ending silently', async () => {
    const calls: SpawnTurnOptions[] = [];
    const runner = {
      runTurn: jest.fn((opts: SpawnTurnOptions) => {
        calls.push(opts);
        return { promise: Promise.resolve(base({ exitCode: 3, result: { conversation_id: 'c', status: 'ERROR', error: QUOTA } })), abort: () => {} };
      }),
    } as unknown as AgyRunner;
    const bridge = new AcpBridge(runner, { defaultModel: 'gpt-oss-120b-medium', conversational: false, contextTrimming: false, mcpGating: false });
    const { sessionId } = await bridge.newSession({ cwd: '/w' });
    const cx: ClientConnection = { notify: async () => {}, request: async () => ({}) };
    await expect(bridge.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx)).rejects.toThrow(/RESOURCE_EXHAUSTED/);
    expect(calls[0]?.model).toBe('gpt-oss-120b-medium');
    expect(calls[0]?.stallMs).toBeUndefined();
    expect(calls[0]?.effort).toBe('medium'); // legacy pinned behavior unchanged
  });
});
