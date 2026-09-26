import { AutoCompAdapter, type AutoCompAdapterOptions } from './autocomp-adapter.js';

export interface MemorySessionContext {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  prompt?: string;
  status?: string;
}

/**
 * Harness-facing memory contract. AutoComp remains the sole lifecycle writer;
 * MemoryBridge and GraphRAG stay behind the shared adapter process.
 */
export class MemoryAdapter {
  private readonly autocomp: AutoCompAdapter;

  constructor(options: AutoCompAdapterOptions = {}) {
    this.autocomp = new AutoCompAdapter(options);
  }

  public sessionStart(context: MemorySessionContext): void {
    this.autocomp.emit({ event: 'session_start', ...this.toEvent(context) });
  }

  public checkpoint(context: MemorySessionContext): void {
    this.autocomp.emit({ event: 'checkpoint', ...this.toEvent(context) });
  }

  public sessionEnd(context: MemorySessionContext): void {
    this.autocomp.emit({ event: 'session_end', ...this.toEvent(context) });
  }

  public async flush(): Promise<void> {
    await this.autocomp.flush();
  }

  private toEvent(context: MemorySessionContext) {
    return {
      sessionId: context.sessionId,
      cwd: context.cwd,
      conversationId: context.conversationId,
      recentUserRequests: context.prompt ? [context.prompt.slice(0, 1200)] : undefined,
      status: context.status,
      source: 'gemini-acp',
    };
  }
}
