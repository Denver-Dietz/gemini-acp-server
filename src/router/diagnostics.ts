import { AgyRunner } from '../agy-process.js';
import { allModels, tierName, type Tier } from './config.js';
import { classifyFailure } from './error-classifier.js';
import { formatDuration } from './model-health.js';
import type { ModelRouter } from './router.js';

export function formatRouterStatus(router: ModelRouter): string {
  const lines: string[] = [];
  for (const tier of [0, 1, 2] as Tier[]) {
    lines.push(`Tier ${tier} (${tierName(tier)}):`);
    for (const model of router.cfg.tiers[tier]) {
      const forMs = router.health.blockedFor(model);
      const entry = router.health.get(model);
      if (forMs > 0 && entry) {
        const label = entry.soft ? 'suspect' : entry.kind;
        lines.push(`  x ${model.padEnd(28)} ${label}, back in ${formatDuration(forMs)}  - ${entry.reason.slice(0, 90)}`);
      } else {
        const last = router.health.lastSuccessAt(model);
        lines.push(`  o ${model.padEnd(28)} available${last ? ` (last ok ${formatDuration(router.health.nowMs() - last)} ago)` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

export interface CheckResult {
  model: string;
  ok: boolean;
  seconds: number;
  detail: string;
}

/**
 * Sends one tiny prompt to each model at full fidelity (waiting out agy's own retries) so the recorded
 * failure carries the provider's real message and reset time.
 */
export async function checkModels(
  runner: AgyRunner,
  router: ModelRouter,
  models: string[] = allModels(router.cfg),
  cwd: string = process.cwd(),
  concurrency = 3,
  log: (line: string) => void = () => {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const queue = [...models];

  async function worker(): Promise<void> {
    for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
      const started = Date.now();
      let result: CheckResult;
      try {
        const { promise } = runner.runTurn(
          { prompt: 'Reply with exactly the word: pong', cwd, model, printTimeout: '4m' },
          () => {},
        );
        const turn = await promise;
        const seconds = (Date.now() - started) / 1000;
        if (turn.result?.status === 'ERROR') {
          const failure = classifyFailure({ error: turn.result.error, stderr: turn.stderr });
          router.recordFailure(model, failure);
          result = { model, ok: false, seconds, detail: `${failure.kind}: ${failure.message.slice(0, 160)}` };
        } else {
          router.recordSuccess(model);
          result = { model, ok: true, seconds, detail: (turn.result?.response ?? '').trim().slice(0, 40) || 'ok' };
        }
      } catch (err) {
        const seconds = (Date.now() - started) / 1000;
        const failure = classifyFailure({ error: err instanceof Error ? err.message : String(err) });
        router.recordFailure(model, failure);
        result = { model, ok: false, seconds, detail: `${failure.kind}: ${failure.message.slice(0, 160)}` };
      }
      results.push(result);
      log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.model.padEnd(28)} ${result.seconds.toFixed(0).padStart(4)}s  ${result.detail}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
  return results;
}
