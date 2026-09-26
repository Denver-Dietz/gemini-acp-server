import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tier = 0 | 1 | 2;

export interface RouterConfig {
  /** Ordered candidate models per tier; the first one that is not blocked wins. */
  tiers: Record<Tier, string[]>;
  /** Heuristic score at/above which a prompt is treated as tier 1 / tier 2. */
  thresholds: { mid: number; high: number };
  cooldowns: {
    /** Used for quota errors that do not state a reset time; escalates on repeated failures. */
    limitMs: number[];
    /** Transient capacity errors (503 "No capacity"). */
    capacityMs: number;
    /** No output within stallMs. */
    stallMs: number;
    /** Not logged in / unauthenticated. */
    authMs: number;
    /** Sibling models of one that hit a long quota limit, before they have been retested; escalates. */
    suspectMs: number[];
  };
  /** A sibling that worked within this window is assumed to have its own quota and is left alone. */
  suspectGraceMs: number;
  /** When retesting a model that failed before, give up after this many error steps (no waiting out retries). */
  retestMaxErrorSteps: number;
  /** Abort a turn if no agent output/result arrives within this window. Startup alone takes ~40 s. */
  stallTimeoutMs: number;
  /** Max models to try for one turn. */
  maxAttempts: number;
  /** Where blocked-model state is persisted. null keeps it in memory only. */
  healthFile: string | null;
}

const HOUR = 3_600_000;
const MIN = 60_000;

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  tiers: {
    0: [
      'gemini-3.8-flash-low',
      'gemini-3.7-flash-low',
      'gemini-3.6-flash-low',
      'gpt-oss-120b-medium',
      'claude-sonnet-4-6',
    ],
    1: [
      'gemini-3.8-flash-high',
      'gemini-3.1-pro-low',
      'gpt-oss-120b-medium',
      'claude-sonnet-4-6',
    ],
    2: [
      'gemini-3.1-pro-high',
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ],
  },
  thresholds: { mid: 3, high: 6 },
  cooldowns: {
    limitMs: [5 * HOUR, 24 * HOUR, 7 * 24 * HOUR],
    capacityMs: 2 * MIN,
    stallMs: 10 * MIN,
    authMs: 1 * MIN,
    suspectMs: [30 * MIN, 2 * HOUR, 6 * HOUR, 24 * HOUR],
  },
  suspectGraceMs: 1 * HOUR,
  retestMaxErrorSteps: 2,
  stallTimeoutMs: 180_000,
  maxAttempts: 4,
  healthFile: join(homedir(), '.cache', 'gemini-acp-server', 'model-health.json'),
};

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'gemini-acp-server', 'router.json');
}

function mergeConfig(base: RouterConfig, override: Partial<RouterConfig>): RouterConfig {
  return {
    ...base,
    ...override,
    tiers: { ...base.tiers, ...(override.tiers ?? {}) },
    thresholds: { ...base.thresholds, ...(override.thresholds ?? {}) },
    cooldowns: { ...base.cooldowns, ...(override.cooldowns ?? {}) },
  };
}

/** Loads router settings from a JSON file (partial overrides allowed); missing file means defaults. */
export function loadRouterConfig(path?: string): RouterConfig {
  const file = path ?? process.env['AGY_ROUTER_CONFIG'] ?? defaultConfigPath();
  let config = DEFAULT_ROUTER_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RouterConfig>;
    config = mergeConfig(DEFAULT_ROUTER_CONFIG, parsed);
  } catch {
    // no config file (or unreadable): use defaults
  }
  const health = process.env['AGY_ROUTER_HEALTH'];
  if (health) {
    config = { ...config, healthFile: health === 'memory' ? null : health };
  }
  return config;
}

// Claude and GPT-OSS draw on one shared budget (a 5-hour limit on one exhausts the other), so they are one family.
export type Family = 'gemini' | 'partner' | 'other';

export function familyOf(model: string): Family {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('gpt-oss')) return 'partner';
  return 'other';
}

export function allModels(cfg: RouterConfig): string[] {
  return [...new Set([...cfg.tiers[0], ...cfg.tiers[1], ...cfg.tiers[2]])];
}

export function tierName(tier: Tier): string {
  return tier === 0 ? 'simple' : tier === 1 ? 'moderate' : 'complex';
}
