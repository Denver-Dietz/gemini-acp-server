import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { AgyRunner } from './agy-process.js';
import type {
  AgyStreamEvent,
  ServerOptions,
  SessionState,
} from './types.js';

export interface ClientConnection {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

export function extractPromptText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) {
    return '';
  }

  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        return b.text;
      }
      if (b.type === 'resource_link' && typeof b.uri === 'string') {
        return `[Resource: ${b.uri}]`;
      }
      if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
        const res = b.resource as Record<string, unknown>;
        if (typeof res.text === 'string') {
          return res.text;
        }
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function inferToolKind(toolName?: string): 'read' | 'edit' | 'execute' | 'other' {
  if (!toolName) return 'other';
  const lower = toolName.toLowerCase();
  if (
    lower.startsWith('read') ||
    lower.startsWith('view') ||
    lower.startsWith('list') ||
    lower.startsWith('grep') ||
    lower.startsWith('find')
  ) {
    return 'read';
  }
  if (
    lower.startsWith('write') ||
    lower.startsWith('replace') ||
    lower.startsWith('edit') ||
    lower.startsWith('sed')
  ) {
    return 'edit';
  }
  if (lower.includes('command') || lower.includes('terminal') || lower.includes('bash')) {
    return 'execute';
  }
  return 'other';
}

export function extractLocations(parameters?: Record<string, unknown>): Array<{ path: string }> {
  if (!parameters) return [];
  const locations: Array<{ path: string }> = [];

  const candidateKeys = [
    'path',
    'filePath',
    'TargetFile',
    'AbsolutePath',
    'SearchPath',
    'DirectoryPath',
  ];

  for (const key of candidateKeys) {
    const val = parameters[key];
    if (typeof val === 'string' && val.trim()) {
      locations.push({ path: val.trim() });
    }
  }

  return locations;
}

export class AcpBridge {
  private sessions = new Map<string, SessionState>();
  private runner: AgyRunner;
  private options: ServerOptions;

  constructor(runner?: AgyRunner, options: ServerOptions = {}) {
    this.runner = runner ?? new AgyRunner(options.binaryPath ?? 'agy');
    this.options = options;
  }

  public getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  public async initialize(_params?: unknown) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  public async authenticate(_params?: unknown) {
    return {};
  }

  public async newSession(params: {
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: unknown[];
    _meta?: unknown;
  }) {
    const sessionId = randomUUID();
    const session: SessionState = {
      sessionId,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
      mcpServers: params.mcpServers ?? [],
      mode: 'accept-edits',
      activeAbortController: null,
    };

    this.sessions.set(sessionId, session);

    return {
      sessionId,
    };
  }

  public async setSessionMode(
    params: { sessionId: string; modeId: string },
    cx?: ClientConnection,
  ) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    if (params.modeId === 'plan' || params.modeId === 'accept-edits') {
      session.mode = params.modeId;
    }

    if (cx) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: session.mode,
        },
      });
    }

    return {};
  }

  public async prompt(
    params: { sessionId: string; prompt: unknown[] },
    cx: ClientConnection,
  ): Promise<{ stopReason: 'end_turn' | 'cancelled' }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    // Cancel prior turn if still running
    if (session.activeAbortController) {
      session.activeAbortController.abort();
    }

    const abortController = new AbortController();
    session.activeAbortController = abortController;

    const promptText = extractPromptText(params.prompt);
    if (!promptText.trim()) {
      return { stopReason: 'end_turn' };
    }

    const onEvent = async (event: AgyStreamEvent) => {
      await this.handleAgyEvent(session.sessionId, event, cx);
    };

    const { promise } = this.runner.runTurn(
      {
        prompt: promptText,
        cwd: session.cwd,
        conversationId: session.conversationId,
        mode: session.mode,
        additionalDirectories: session.additionalDirectories,
        model: this.options.defaultModel,
        effort: this.options.defaultEffort,
        signal: abortController.signal,
      },
      onEvent,
    );

    try {
      const turnResult = await promise;
      if (turnResult.conversationId) {
        session.conversationId = turnResult.conversationId;
      }

      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      throw err;
    } finally {
      if (session.activeAbortController === abortController) {
        session.activeAbortController = null;
      }
    }
  }

  public async cancel(params: { sessionId: string }) {
    const session = this.sessions.get(params.sessionId);
    if (session?.activeAbortController) {
      session.activeAbortController.abort();
      session.activeAbortController = null;
    }
  }

  private async handleAgyEvent(
    sessionId: string,
    event: AgyStreamEvent,
    cx: ClientConnection,
  ): Promise<void> {
    if (event.event === 'step_update') {
      const update = event.step_update;

      if (update.step_type === 'agent_response' && update.text_delta) {
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: update.text_delta,
            },
          },
        });
      } else if (update.step_type === 'tool') {
        const toolCallId = `call_${update.step_index}`;
        const kind = inferToolKind(update.tool_name);
        const locations = extractLocations(update.tool_info?.parameters);

        if (update.state === 'ACTIVE') {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: update.tool_name ?? 'tool',
              kind,
              status: 'in_progress',
              locations: locations.length > 0 ? locations : undefined,
              rawInput: update.tool_info?.parameters,
            },
          });
        } else if (update.state === 'DONE') {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'completed',
              rawOutput: update.tool_info?.output,
            },
          });
        }
      }

      if (update.usage) {
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            usage: {
              inputTokens: update.usage.input_tokens,
              outputTokens: update.usage.output_tokens,
              cacheReadTokens: update.usage.cache_read_tokens,
              totalTokens: update.usage.total_tokens,
            },
          },
        });
      }
    }
  }
}
