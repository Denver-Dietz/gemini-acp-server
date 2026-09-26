import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { AgyProcessError, AgyRunner } from './agy-process.js';
import { trimPromptBlocks } from './context-trimmer.js';
import { MemoryAdapter } from './memory-adapter.js';
import { createScopedMcpEnvironment, parseMcpMode } from './mcp-router.js';
import type { Tier } from './router/config.js';
import { classifyFailure, type Failure } from './router/error-classifier.js';
import { formatDuration } from './router/model-health.js';
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

export const DEFAULT_CONVERSATIONAL_INSTRUCTION =
  'You are Antigravity, an intelligent, conversational coding assistant and engineering collaborator. ' +
  'Communicate openly and conversationally with the user. Discuss the current work being done, ' +
  'explain your reasoning and architectural choices, suggest improvements, and answer questions thoroughly. ' +
  'When writing code or running commands, maintain full precision and verify your work.';

export function formatConversationalPrompt(
  promptText: string,
  instruction: string = DEFAULT_CONVERSATIONAL_INSTRUCTION,
): string {
  const trimmed = promptText.trim();
  // If the prompt is a machine-oriented JSON plan request or already contains system directive, don't wrap
  if (
    trimmed.includes('Return strictly the requested JSON') ||
    trimmed.includes('[System Directive') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('```json')
  ) {
    return promptText;
  }

  return `[System Directive: Communication Style & Engagement]\n${instruction}\n\n[User Message]\n${promptText}`;
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
  private memoryAdapter: MemoryAdapter;

  constructor(runner?: AgyRunner, options: ServerOptions = {}) {
    this.runner = runner ?? new AgyRunner(options.binaryPath ?? 'agy');
    this.options = options;
    this.memoryAdapter = options.memoryAdapter ?? new MemoryAdapter();
  }

  public getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  public async close(status = 'server_shutdown'): Promise<void> {
    for (const session of this.sessions.values()) {
      this.memoryAdapter.sessionEnd({
        sessionId: session.sessionId,
        cwd: session.cwd,
        conversationId: session.conversationId,
        status,
      });
    }
    await this.memoryAdapter.flush();
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
      meta: params._meta,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
      mcpServers: params.mcpServers ?? [],
      mode: 'accept-edits',
      activeAbortController: null,
    };

    this.sessions.set(sessionId, session);
    this.memoryAdapter.sessionStart({ sessionId, cwd: params.cwd });

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
    params: { sessionId: string; prompt: unknown[]; _meta?: unknown },
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

    const promptText = this.options.contextTrimming !== false
      ? trimPromptBlocks(params.prompt, {
          cwd: session.cwd,
          isOngoingSession: Boolean(session.conversationId),
        })
      : extractPromptText(params.prompt);

    if (!promptText.trim()) {
      return { stopReason: 'end_turn' };
    }

    let finalPrompt = promptText;
    if (this.options.conversational !== false) {
      const instruction = this.options.systemInstruction || DEFAULT_CONVERSATIONAL_INSTRUCTION;
      if (!session.conversationId || Boolean(this.options.systemInstruction)) {
        finalPrompt = formatConversationalPrompt(promptText, instruction);
      }
    }

    const scopedMcp = createScopedMcpEnvironment({
      prompt: finalPrompt,
      enabled: this.options.mcpGating !== false,
      mode: parseMcpMode(params._meta ?? session.meta, this.options.mcpMode ?? 'auto'),
    });

    if (this.options.debug && scopedMcp.disabledServers.length > 0) {
      process.stderr.write(
        `[gemini-acp] MCP Gating: suppressed heavy servers [${scopedMcp.disabledServers.join(', ')}] for turn\n`,
      );
    }

    // ---- model selection: router (complexity + health) or the single pinned model
    const router = this.options.router ?? null;
    const resourceCount = Array.isArray(params.prompt)
      ? params.prompt.filter((b) => b && typeof b === 'object' && ['resource', 'resource_link'].includes((b as { type?: string }).type ?? '')).length
      : 0;
    const decision = router
      ? router.decide(promptText, params._meta ?? session.meta, session.routerTier ?? 0, { resourceCount })
      : null;
    if (router && decision && decision.candidates.length === 0) {
      scopedMcp.cleanup();
      if (session.activeAbortController === abortController) session.activeAbortController = null;
      throw new Error(router.describeExhausted(decision));
    }
    const models: Array<string | undefined> = decision ? decision.candidates : [this.options.defaultModel];
    let lastFailure: Failure | undefined;
    let attempts = 0;

    try {
      for (const model of models) {
        if (abortController.signal.aborted) return { stopReason: 'cancelled' };
        // health can change mid-turn (a failed attempt may mark its siblings suspect), so re-check now
        if (router && model && router.health.blockedFor(model) > 0) continue;
        if (router && attempts >= router.cfg.maxAttempts) break;
        attempts++;

        if (router && decision && (attempts > 1 || model !== session.lastModel)) {
          await this.notice(cx, session.sessionId, `${router.describe({ ...decision, candidates: [model ?? ''] })}${attempts > 1 ? ' (fallback)' : ''}`);
        }

        let emitted = false;
        const onEvent = async (event: AgyStreamEvent): Promise<void> => {
          if (
            event.event === 'step_update' &&
            ((event.step_update.step_type === 'agent_response' && Boolean(event.step_update.text_delta)) ||
              event.step_update.step_type === 'tool')
          ) {
            emitted = true;
          }
          await this.handleAgyEvent(session.sessionId, event, cx);
        };

        const { promise } = this.runner.runTurn(
          {
            prompt: finalPrompt,
            cwd: session.cwd,
            conversationId: session.conversationId,
            mode: session.mode,
            additionalDirectories: session.additionalDirectories,
            model,
            // routed models encode their effort in the name (or reject --effort entirely), so never send it
            effort: router ? undefined : (this.options.defaultEffort ?? 'medium'),
            printTimeout: this.options.printTimeout,
            homeDir: scopedMcp.homeDir,
            signal: abortController.signal,
            stallMs: router && decision ? router.cfg.stallTimeoutMs * (decision.tier >= 1 ? 2 : 1) : undefined,
            maxErrorSteps: router && model && router.isRetest(model) ? router.cfg.retestMaxErrorSteps : undefined,
          },
          onEvent,
        );

        let failure: Failure | undefined;
        try {
          const turn = await promise;
          if (abortController.signal.aborted && !turn.stalled && !turn.errorAborted) {
            return { stopReason: 'cancelled' };
          }
          if (turn.errorAborted && router && model) {
            // retest of a known-bad model: the reason has not changed, so keep it and skip the wait
            const prev = router.health.get(model);
            failure = { kind: prev?.kind ?? 'limit', message: `still failing on retest (${prev?.reason ?? 'unknown'})` };
          } else if (turn.stalled) {
            failure = classifyFailure({ stalled: true, stderr: turn.stderr, error: `No output from ${model ?? 'agy'} within the stall window` });
          } else if (turn.result?.status === 'ERROR') {
            failure = classifyFailure({ error: turn.result.error, stderr: turn.stderr });
          } else {
            if (turn.conversationId) session.conversationId = turn.conversationId;
            if (router && decision && model) {
              router.recordSuccess(model);
              session.routerTier = Math.max(session.routerTier ?? 0, decision.tier) as Tier;
              session.lastModel = model;
            }
            this.memoryAdapter.checkpoint({
              sessionId: session.sessionId,
              cwd: session.cwd,
              conversationId: turn.conversationId ?? session.conversationId,
              prompt: promptText,
              status: 'success',
            });
            return { stopReason: 'end_turn' };
          }
        } catch (err) {
          if (abortController.signal.aborted) return { stopReason: 'cancelled' };
          if (!router) throw err;
          const stderr = err instanceof AgyProcessError ? err.stderr : '';
          failure = classifyFailure({ error: err instanceof Error ? err.message : String(err), stderr });
        }

        // ---- the attempt failed
        lastFailure = failure;
        if (!router || !decision || !model) {
          throw new Error(failure.message);
        }
        const blockedMs = router.recordFailure(model, failure);
        const blockNote = blockedMs > 0 ? `; skipping it for ${formatDuration(blockedMs)}` : '';
        await this.notice(cx, session.sessionId, `${model} failed (${failure.kind}: ${failure.message.slice(0, 140)})${blockNote}`);
        if (this.options.debug) {
          process.stderr.write(`[gemini-acp] router: ${model} ${failure.kind} -> ${failure.message}\n`);
        }

        // Output already reached the client, so replaying on another model would duplicate it.
        if (emitted) throw new Error(`${model} failed mid-turn: ${failure.message}`);
        // Login problems affect every model; do not burn the whole ladder on them.
        if (failure.kind === 'auth') throw new Error(failure.message);
      }

      const exhausted = router && decision ? router.decideForTier(decision.tier) : null;
      throw new Error(
        exhausted && exhausted.candidates.length === 0
          ? router!.describeExhausted(exhausted)
          : `Turn failed on ${attempts} model(s): ${lastFailure?.message ?? 'unknown error'}`,
      );
    } finally {
      scopedMcp.cleanup();
      if (session.activeAbortController === abortController) {
        session.activeAbortController = null;
      }
    }
  }

  /** Routing/fallback messages go out as thought chunks so they never mix into the model's answer. */
  private async notice(cx: ClientConnection, sessionId: string, text: string): Promise<void> {
    try {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `[router] ${text}\n` },
        },
      });
    } catch {
      // notices are best-effort
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
              sessionUpdate: 'tool_call_update',
              toolCallId,
              title: update.tool_name ?? 'tool',
              kind,
              status: 'in_progress',
              locations: locations.length > 0 ? locations : undefined,
              rawInput: update.tool_info?.parameters,
            },
          });
        } else if (update.state === 'DONE') {
          const rawOutput = update.tool_info?.output;
          const isError =
            typeof rawOutput === 'string' &&
            rawOutput.includes('The command exited with code') &&
            !rawOutput.includes('The command exited with code 0');

          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              rawOutput,
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
    } else if (event.event === 'result') {
      const res = event.result;
      if (res.usage) {
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            usage: {
              inputTokens: res.usage.input_tokens,
              outputTokens: res.usage.output_tokens,
              cacheReadTokens: res.usage.cache_read_tokens,
              totalTokens: res.usage.total_tokens,
            },
          },
        });
      }
    }
  }
}
