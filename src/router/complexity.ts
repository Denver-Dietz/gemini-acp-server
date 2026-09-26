import type { RouterConfig, Tier } from './config.js';

export interface Complexity {
  tier: Tier;
  score: number;
  source: 'hint' | 'heuristic';
  reasons: string[];
}

const WORDS_TO_TIER: Record<string, Tier> = {
  '0': 0, low: 0, simple: 0, cheap: 0,
  '1': 1, mid: 1, medium: 1, moderate: 1,
  '2': 2, high: 2, complex: 2, hard: 2,
};

/** Reads an explicit tier from ACP `_meta` (`_meta.agyRouter.tier`, or `_meta.tier`). */
export function parseTierHint(meta: unknown): Tier | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const router = m['agyRouter'];
  const raw = router && typeof router === 'object' ? (router as Record<string, unknown>)['tier'] : m['tier'];
  if (raw === undefined || raw === null) return undefined;
  return WORDS_TO_TIER[String(raw).toLowerCase()];
}

interface Signal {
  pattern: RegExp;
  weight: number;
  label: string;
}

// Cues that a task needs real reasoning rather than a routine edit.
const REASONING_SIGNALS: Signal[] = [
  { pattern: /\b(architect(ure)?|system design|design (a|the) (system|service|api|schema))\b/i, weight: 2, label: 'architecture/design' },
  { pattern: /\btrade-?offs?\b|\bpros and cons\b|\bcompare (approaches|options)\b/i, weight: 1.5, label: 'trade-off analysis' },
  { pattern: /\broot cause\b|\bwhy (does|is|did)\b.*\b(fail|crash|hang|leak|slow)/i, weight: 1.5, label: 'root-cause analysis' },
  { pattern: /\b(race condition|deadlock|concurrency|memory leak|distributed|consensus)\b/i, weight: 2, label: 'hard systems problem' },
  { pattern: /\b(security (audit|review)|threat model|vulnerabilit(y|ies))\b/i, weight: 2, label: 'security review' },
  { pattern: /\b(migrat(e|ion)|refactor (the )?(entire|whole|across)|rewrite (the )?(entire|whole))\b/i, weight: 2, label: 'large migration/refactor' },
  { pattern: /\b(optimi[sz]e|profil(e|ing)|complexity)\b.*\b(algorithm|performance|latency|throughput)\b/i, weight: 1.5, label: 'performance work' },
  { pattern: /\b(prove|formal(ly)?|invariant|correctness)\b/i, weight: 1.5, label: 'formal reasoning' },
  { pattern: /\b(multi-?(step|task|phase)|end-to-end|cannot be (delegated|split)|interdependent)\b/i, weight: 1.5, label: 'multi-task plan' },
  { pattern: /\bPlanContract\b|\bdecompose\b.*\b(tasks?|plan)\b|\bLead Architect\b/i, weight: 2.5, label: 'plan decomposition' },
];

const TRIVIAL_SIGNALS: Signal[] = [
  { pattern: /\b(typo|rename|fix (the )?import|add (a )?comment|format(ting)?|lint)\b/i, weight: -1.5, label: 'trivial edit' },
  { pattern: /^\s*(what|which|where|who|when)\b.{0,120}\?\s*$/i, weight: -1, label: 'short question' },
  { pattern: /\breply with (exactly|just|only)\b/i, weight: -2, label: 'constrained reply' },
];

export interface ScoreOptions {
  /** Number of file/resource references attached to the prompt. */
  resourceCount?: number;
}

/** Cheap local scorer: no model call. Biased toward tier 0; escalation has to be earned. */
export function scoreComplexity(prompt: string, cfg: RouterConfig, opts: ScoreOptions = {}): Complexity {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, why: string): void => {
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`);
  };

  const len = prompt.length;
  if (len > 6000) add(2, 'very long prompt');
  else if (len > 2000) add(1, 'long prompt');
  else if (len < 200) add(-0.5, 'short prompt');

  let reasoningHits = 0;
  for (const s of REASONING_SIGNALS) {
    if (s.pattern.test(prompt)) {
      add(s.weight, s.label);
      reasoningHits++;
    }
  }
  // several independent hard cues together mean genuinely hard, not a stray keyword
  if (reasoningHits >= 3) add(1, 'multiple independent reasoning cues');
  for (const s of TRIVIAL_SIGNALS) {
    if (s.pattern.test(prompt)) add(s.weight, s.label);
  }

  const numbered = (prompt.match(/^\s*(\d+[.)]|[-*])\s+\S/gm) ?? []).length;
  if (numbered >= 6) add(1.5, `${numbered} list items`);
  else if (numbered >= 3) add(1, `${numbered} list items`);

  if (/Traceback \(most recent call last\)|\bat .+\(.+:\d+:\d+\)|panic:|Exception in thread/.test(prompt)) {
    add(1, 'stack trace');
  }

  const files = opts.resourceCount ?? 0;
  if (files >= 8) add(2, `${files} files referenced`);
  else if (files >= 4) add(1, `${files} files referenced`);

  const tier: Tier = score >= cfg.thresholds.high ? 2 : score >= cfg.thresholds.mid ? 1 : 0;
  return { tier, score: Math.round(score * 10) / 10, source: 'heuristic', reasons };
}

/** Explicit hint wins; otherwise the heuristic decides. */
export function assessComplexity(prompt: string, meta: unknown, cfg: RouterConfig, opts: ScoreOptions = {}): Complexity {
  const hinted = parseTierHint(meta);
  if (hinted !== undefined) {
    return { tier: hinted, score: hinted, source: 'hint', reasons: [`caller hint tier ${hinted}`] };
  }
  return scoreComplexity(prompt, cfg, opts);
}
