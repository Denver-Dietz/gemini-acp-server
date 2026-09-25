import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgyStreamEvent,
  AgyResultData,
  SpawnTurnOptions,
} from './types.js';

export class AgyProcessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'AgyProcessError';
  }
}

export function parseAgyEvent(line: string): AgyStreamEvent | null {
  if (line.length === 0) return null;
  // Fast path: NDJSON lines arrive without leading whitespace — avoid the trim() allocation.
  if (line.charCodeAt(0) === 0x7b /* { */) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed.event === 'string') return parsed as unknown as AgyStreamEvent;
    } catch {
      // Non-JSON output or partial log line
    }
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed.event === 'string') return parsed as unknown as AgyStreamEvent;
  } catch {
    // Non-JSON output or partial log line
  }
  return null;
}

export function buildAgyArgs(options: SpawnTurnOptions): string[] {
  const args: string[] = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--print-timeout',
    options.printTimeout || '30m',
  ];

  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  }

  if (options.mode) {
    args.push('--mode', options.mode);
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    for (const dir of options.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }

  return args;
}

export interface RunTurnResult {
  conversationId?: string;
  result?: AgyResultData;
  exitCode: number | null;
  /** True when the turn was aborted because no output arrived within `stallMs`. */
  stalled: boolean;
  /** True when the turn was aborted after `maxErrorSteps` error steps without any output. */
  errorAborted: boolean;
  stderr: string;
}

export class AgyRunner {
  private binaryPath: string;

  constructor(binaryPath: string = 'agy') {
    this.binaryPath = binaryPath;
  }

  public setBinaryPath(path: string): void {
    this.binaryPath = path;
  }

  public getBinaryPath(): string {
    return this.binaryPath;
  }

  /**
   * Spawns an Antigravity CLI process for a single turn and streams NDJSON events.
   */
  public runTurn(
    options: SpawnTurnOptions,
    onEvent: (event: AgyStreamEvent) => void | Promise<void>,
  ): { promise: Promise<RunTurnResult>; abort: () => void } {
    const args = buildAgyArgs(options);
    let child: ChildProcess | null = null;
    let aborted = false;
    let stalled = false;
    let errorAborted = false;
    let errorSteps = 0;
    let sawOutput = false;
    let stallTimer: NodeJS.Timeout | undefined;
    const clearStall = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    const abort = (): void => {
      aborted = true;
      if (child && !child.killed) {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child && !child.killed) {
              child.kill('SIGKILL');
            }
          }, 3000).unref();
        } catch {
          // Process already dead
        }
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        return {
          promise: Promise.reject(new Error('Turn was aborted before execution started')),
          abort,
        };
      }
      options.signal.addEventListener('abort', abort, { once: true });
    }

    const promise = new Promise<RunTurnResult>((resolve, reject) => {
      let stderrAccumulator = '';
      let conversationId = options.conversationId;
      let lastResult: AgyResultData | undefined;

      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...(options.env || {}),
      };
      if (options.homeDir) {
        spawnEnv['HOME'] = options.homeDir;
      }

      try {
        child = spawn(this.binaryPath, args, {
          cwd: options.cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }

      if (options.stallMs && options.stallMs > 0) {
        stallTimer = setTimeout(() => {
          stalled = true;
          abort();
        }, options.stallMs);
        stallTimer.unref();
      }

      if (!child.stdout || !child.stderr) {
        return reject(new Error('Failed to attach stdout/stderr to agy process'));
      }

      const rl = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        const event = parseAgyEvent(line);
        if (!event) return;

        // the model is alive once it produces output or a final result (init/user_input arrive regardless)
        if (
          event.event === 'result' ||
          (event.event === 'step_update' && event.step_update.step_type !== 'user_input')
        ) {
          clearStall();
        }

        if (event.event === 'step_update') {
          const type = event.step_update.step_type as string;
          if (type === 'agent_response' || type === 'tool') sawOutput = true;
          if (type === 'error_message' && !sawOutput && options.maxErrorSteps && ++errorSteps >= options.maxErrorSteps) {
            errorAborted = true;
            abort();
          }
        }

        if (event.event === 'init' && event.conversation_id) {
          conversationId = event.conversation_id;
        } else if (event.event === 'result') {
          lastResult = event.result;
          if (event.result.conversation_id) {
            conversationId = event.result.conversation_id;
          }
        }

        try {
          const res = onEvent(event);
          if (res instanceof Promise) {
            // Fire-and-forget for non-critical events to avoid Nagle delays
            // Only critical events like 'result' should block the pipeline
            if (event.event !== 'result') {
              res.catch((e) => {
                process.stderr.write(`[gemini-acp] Error in onEvent handler: ${e}\n`);
              });
            } else {
              // For result events, catch errors but don't await (result is already captured above)
              res.catch((e) => {
                process.stderr.write(`[gemini-acp] Error in onEvent handler: ${e}\n`);
              });
            }
          }
        } catch (e) {
          process.stderr.write(`[gemini-acp] Error in onEvent handler: ${e}\n`);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrAccumulator += chunk.toString();
      });

      child.on('error', (err) => {
        clearStall();
        reject(err);
      });

      child.on('close', (code) => {
        clearStall();
        if (options.signal) {
          options.signal.removeEventListener('abort', abort);
        }

        if (aborted) {
          return resolve({
            conversationId,
            result: lastResult,
            exitCode: code,
            stalled,
            errorAborted,
            stderr: stderrAccumulator,
          });
        }

        if (code !== 0 && !lastResult) {
          return reject(
            new AgyProcessError(
              `agy process exited with code ${code}: ${stderrAccumulator.trim()}`,
              code,
              stderrAccumulator,
            ),
          );
        }

        resolve({
          conversationId,
          result: lastResult,
          exitCode: code,
          stalled: false,
          errorAborted: false,
          stderr: stderrAccumulator,
        });
      });
    });

    return { promise, abort };
  }
}
