import { allModels, familyOf, tierName, type RouterConfig, type Tier } from './config.js';
import { assessComplexity, type Complexity, type ScoreOptions } from './complexity.js';
import type { Failure } from './error-classifier.js';
import { formatDuration, ModelHealth } from './model-health.js';

export interface RouteDecision {
  tier: Tier;
  complexity: Complexity;
  /** Models to try, in order, with blocked ones already removed. */
  candidates: string[];
  /** Blocked models for the chosen ladder, with time remaining (for error messages). */
  blocked: Array<{ model: string; forMs: number; reason: string }>;
}

/**
 * Picks the model for a turn: complexity decides the tier, the tier's ladder gives the order, and
 * health state removes models that are rate-limited, out of capacity, or stalled.
 */
export class ModelRouter {
  constructor(
    readonly cfg: RouterConfig,
    readonly health: ModelHealth,
  ) {}

  /** Order to try for a tier: its own ladder, then the neighbouring tiers as a last resort. */
  private cache = new Map<Tier, string[]>();

  private ladder(tier: Tier): string[] {
    const cached = this.cache.get(tier);
    if (cached !== undefined) return cached;
    const order: Tier[] = tier === 0 ? [0, 1, 2] : tier === 1 ? [1, 2, 0] : [2, 1, 0];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of order) {
      for (const model of this.cfg.tiers[t]) {
        if (!seen.has(model)) {
          seen.add(model);
          out.push(model);
        }
      }
    }
    this.cache.set(tier, out);
    return out;
  }

  decide(prompt: string, meta: unknown, minTier: Tier = 0, opts: ScoreOptions = {}): RouteDecision {
    const complexity = assessComplexity(prompt, meta, this.cfg, opts);
    // a conversation never drops below the highest tier it has needed
    const tier = (Math.max(complexity.tier, minTier) as Tier);
    return this.decideForTier(tier, complexity);
  }

  decideForTier(tier: Tier, complexity?: Complexity): RouteDecision {
    const candidates: string[] = [];
    const blocked: RouteDecision['blocked'] = [];
    for (const model of this.ladder(tier)) {
      const forMs = this.health.blockedFor(model);
      if (forMs > 0) {
        blocked.push({ model, forMs, reason: this.health.get(model)?.reason ?? '' });
      } else {
        candidates.push(model);
      }
    }
    return {
      tier,
      complexity: complexity ?? { tier, score: tier, source: 'hint', reasons: [] },
      candidates,
      blocked,
    };
  }

  recordSuccess(model: string): void {
    this.health.clear(model);
  }

  recordFailure(model: string, failure: Failure): number {
    const ms = this.health.block(model, failure, this.cfg);
    // A long quota reset usually means a shared bucket: stop paying minutes of retries per sibling.
    if (failure.kind === 'limit' && (failure.resetMs ?? 0) > 3_600_000) this.suspectSiblings(model);
    return ms;
  }

  private suspectSiblings(failed: string): void {
    const family = familyOf(failed);
    if (family === 'other') return; // unknown models are not assumed to share a quota
    for (const other of allModels(this.cfg)) {
      if (other === failed || familyOf(other) !== family || this.health.blockedFor(other) > 0) continue;
      const last = this.health.lastSuccessAt(other);
      // it worked recently, so it evidently has its own quota
      if (last !== undefined && this.health.nowMs() - last < this.cfg.suspectGraceMs) continue;
      this.health.suspect(other, this.cfg, `sibling ${failed} hit a quota limit; shared bucket suspected`);
    }
  }

  /** True when the model failed before and this attempt is a retest (so waiting out retries is wasteful). */
  isRetest(model: string): boolean {
    return this.health.get(model) !== undefined;
  }

  describe(decision: RouteDecision): string {
    const first = decision.candidates[0] ?? 'none available';
    const why = decision.complexity.source === 'hint' ? 'hint' : `score ${decision.complexity.score}`;
    return `tier ${decision.tier} (${tierName(decision.tier)}, ${why}) -> ${first}`;
  }

  describeExhausted(decision: RouteDecision): string {
    if (decision.blocked.length === 0) return 'No models are configured for routing.';
    const lines = decision.blocked.map((b) => `  ${b.model}: unavailable for ${formatDuration(b.forMs)} (${b.reason.slice(0, 120)})`);
    return `All candidate models are currently unavailable:\n${lines.join('\n')}`;
  }
}
