import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RouterConfig } from './config.js';
import type { Failure, FailureKind } from './error-classifier.js';

export interface HealthEntry {
  blockedUntil: number;
  kind: FailureKind;
  reason: string;
  /** Consecutive limit failures, used to escalate 5h -> 24h -> 7d when no reset time is given. */
  strikes: number;
  updatedAt: number;
  /** True for a precautionary block (sibling hit a limit) rather than a confirmed failure. */
  soft?: boolean;
}

/**
 * Remembers which models are unavailable and until when. Which models share a quota bucket is not
 * observable (live probes showed some Gemini models working while others were exhausted, then all of them
 * exhausted with near-identical reset times), so a confirmed failure blocks only that model and its
 * family siblings are merely marked "suspect" for a short, escalating window and retested cheaply.
 */
export class ModelHealth {
  private entries = new Map<string, HealthEntry>();
  private successes = new Map<string, number>();

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        entries?: Record<string, HealthEntry>;
        successes?: Record<string, number>;
      };
      for (const [model, entry] of Object.entries(raw.entries ?? {})) this.entries.set(model, entry);
      for (const [model, at] of Object.entries(raw.successes ?? {})) this.successes.set(model, at);
    } catch {
      // first run or unreadable file: start clean
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ entries: Object.fromEntries(this.entries), successes: Object.fromEntries(this.successes) }, null, 2),
      );
      renameSync(tmp, this.file);
    } catch {
      // persistence is best-effort; routing still works in memory
    }
  }

  nowMs(): number {
    return this.now();
  }

  /** Milliseconds until the model is usable again; 0 when it is available. */
  blockedFor(model: string): number {
    const entry = this.entries.get(model);
    if (!entry) return 0;
    const remaining = entry.blockedUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  get(model: string): HealthEntry | undefined {
    return this.entries.get(model);
  }

  /** Records a failure and returns how long the model is blocked. `other` failures never block. */
  block(model: string, failure: Failure, cfg: RouterConfig): number {
    if (failure.kind === 'other') return 0;
    const prev = this.entries.get(model);
    let strikes = 0;
    let ms: number;
    switch (failure.kind) {
      case 'limit': {
        // limited again within 12h of coming back means the previous cooldown was too short: escalate
        const relapse = prev?.kind === 'limit' && this.now() < prev.blockedUntil + 12 * 3_600_000;
        strikes = relapse ? (prev?.strikes ?? 0) + 1 : 0;
        const ladder = cfg.cooldowns.limitMs;
        const fallback = ladder[Math.min(strikes, ladder.length - 1)] ?? 5 * 3_600_000;
        // a stated reset time is authoritative; add a small buffer so we do not retry a moment early
        ms = failure.resetMs ? failure.resetMs + 60_000 : fallback;
        break;
      }
      case 'capacity':
        ms = cfg.cooldowns.capacityMs;
        break;
      case 'stall':
        ms = cfg.cooldowns.stallMs;
        break;
      case 'auth':
        ms = cfg.cooldowns.authMs;
        break;
    }
    this.entries.set(model, {
      blockedUntil: this.now() + ms,
      kind: failure.kind,
      reason: failure.message.slice(0, 300),
      strikes,
      updatedAt: this.now(),
    });
    this.save();
    return ms;
  }

  /** A successful turn proves the model works: clears any block and remembers when. */
  clear(model: string): void {
    this.entries.delete(model);
    this.successes.set(model, this.now());
    this.save();
  }

  lastSuccessAt(model: string): number | undefined {
    return this.successes.get(model);
  }

  /**
   * Precautionary block for a model whose sibling just hit a long quota limit. Cheap to retest later,
   * and escalates if retests keep failing so an exhausted pool is not probed every half hour.
   */
  suspect(model: string, cfg: RouterConfig, reason: string): number {
    const prev = this.entries.get(model);
    const relapse = prev !== undefined && this.now() < prev.blockedUntil + 12 * 3_600_000;
    const strikes = relapse ? prev.strikes + 1 : 0;
    const ladder = cfg.cooldowns.suspectMs;
    const ms = ladder[Math.min(strikes, ladder.length - 1)] ?? 30 * 60_000;
    this.entries.set(model, {
      blockedUntil: this.now() + ms,
      kind: 'limit',
      reason: reason.slice(0, 300),
      strikes,
      updatedAt: this.now(),
      soft: true,
    });
    this.save();
    return ms;
  }

  snapshot(): Array<{ model: string; blockedForMs: number; entry: HealthEntry }> {
    return [...this.entries.entries()]
      .map(([model, entry]) => ({ model, blockedForMs: this.blockedFor(model), entry }))
      .filter((row) => row.blockedForMs > 0)
      .sort((a, b) => b.blockedForMs - a.blockedForMs);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m && !d ? `${m}m` : ''].filter(Boolean).join('') || '0m';
}
