import { spawn } from 'node:child_process';
import fs from 'node:fs';

export interface AdapterEvent {
  event: 'session_start' | 'checkpoint' | 'session_end';
  harness: string;
  sessionId: string;
  cwd: string;
  conversationId?: string;
  recentUserRequests?: string[];
  status?: string;
  source?: string;
}

export interface AutoCompAdapterOptions {
  enabled?: boolean;
  scriptPath?: string;
  pythonPath?: string;
  timeoutMs?: number;
  maxQueue?: number;
  harness?: string;
}

/**
 * Non-blocking boundary to the shared AutoComp lifecycle adapter.
 * The ACP request path never waits for Python, MemoryBridge, or GraphRAG.
 */
export class AutoCompAdapter {
  private readonly enabled: boolean;
  private readonly scriptPath: string;
  private readonly pythonPath: string;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private readonly harness: string;
  private queue: AdapterEvent[] = [];
  private draining = false;

  constructor(options: AutoCompAdapterOptions = {}) {
    this.scriptPath = options.scriptPath ?? process.env['GEMINI_ACP_AUTOCOMP_ADAPTER'] ??
      '/home/prime/.local/share/Memory-System/AutoComp-HarnessAdapters/autocomp-adapter.py';
    this.pythonPath = options.pythonPath ?? process.env['PYTHON'] ?? 'python3';
    // Lifecycle writes are fail-open during turns, but must have enough time
    // to reach AutoComp and MemoryBridge when the server is shutting down.
    this.timeoutMs = options.timeoutMs ?? Number(process.env['GEMINI_ACP_ADAPTER_TIMEOUT_MS'] ?? 5000);
    this.maxQueue = options.maxQueue ?? 8;
    // ACP is a transport in front of Antigravity; use the shared Antigravity
    // continuity identity so ACP and direct Antigravity sessions converge.
    this.harness = options.harness ?? process.env['GEMINI_ACP_HARNESS'] ?? 'antigravity';
    this.enabled = options.enabled ?? (
      process.env['GEMINI_ACP_MEMORY_ADAPTER'] !== '0' &&
      process.env['NODE_ENV'] !== 'test' &&
      fs.existsSync(this.scriptPath)
    );
  }

  public emit(event: Omit<AdapterEvent, 'harness'>): void {
    if (!this.enabled) return;
    const item: AdapterEvent = { ...event, harness: this.harness };
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push(item);
    void this.drain();
  }

  public async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item) await this.send(item);
      }
    } finally {
      this.draining = false;
    }
  }

  private send(payload: AdapterEvent): Promise<void> {
    return new Promise((resolve) => {
      const eventName = payload.event === 'session_start'
        ? 'SessionStart'
        : payload.event === 'session_end' ? 'SessionEnd' : 'Stop';
      const child = spawn(this.pythonPath, [this.scriptPath, eventName], {
        env: {
          ...process.env,
          MEMORY_ADAPTER_HARNESS: this.harness,
          MEMORY_ADAPTER_OUTPUT: 'json',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, this.timeoutMs);
      timer.unref();
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end(JSON.stringify({
        hook_event_name: eventName,
        client_id: this.harness,
        session_id: payload.sessionId,
        cwd: payload.cwd,
        conversationId: payload.conversationId,
        recent_user_requests: payload.recentUserRequests,
        status: payload.status,
        source: payload.source ?? 'gemini-acp',
      }));
    });
  }
}
