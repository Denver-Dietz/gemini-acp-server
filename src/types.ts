/**
 * Core type definitions for Antigravity ACP Server.
 */

import type { ModelRouter } from './router/router.js';
import type { McpMode } from './mcp-router.js';
import type { Tier } from './router/config.js';
import type { MemoryAdapter } from './memory-adapter.js';

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolInfo {
  name: string;
  parameters?: Record<string, unknown>;
  output?: string;
}

export interface AgyInitData {
  cwd: string;
  tools: string[];
  permission_mode?: string;
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id: string;
  init: AgyInitData;
}

export interface AgyStepUpdateData {
  conversation_id: string;
  step_index: number;
  state: 'ACTIVE' | 'DONE';
  step_type: 'user_input' | 'agent_response' | 'tool';
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  duration_seconds?: number;
  usage?: AgyUsage;
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: AgyStepUpdateData;
}

export interface AgyResultData {
  conversation_id: string;
  status: 'SUCCESS' | 'ERROR';
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
}

export interface AgyResultEvent {
  event: 'result';
  result: AgyResultData;
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export interface ServerOptions {
  binaryPath?: string;
  defaultModel?: string;
  defaultEffort?: 'low' | 'medium' | 'high';
  printTimeout?: string;
  debug?: boolean;
  contextTrimming?: boolean;
  mcpGating?: boolean;
  /** Default MCP mode (`_meta.agyRouter.mcp` overrides per session/turn). */
  mcpMode?: McpMode;
  conversational?: boolean;
  systemInstruction?: string;
  /** When set, models are chosen per turn by complexity and health instead of one fixed model. */
  router?: ModelRouter | null;
  /** Shared AutoComp/MemoryBridge lifecycle adapter; fail-open and non-blocking. */
  memoryAdapter?: MemoryAdapter;
}

export interface SpawnTurnOptions {
  prompt: string;
  cwd: string;
  conversationId?: string;
  mode?: 'accept-edits' | 'plan';
  additionalDirectories?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  printTimeout?: string;
  homeDir?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Abort the turn if no agent output or result arrives within this many ms. */
  stallMs?: number;
  /** Abort after this many error_message steps with no output (used when retesting a failed model). */
  maxErrorSteps?: number;
  conversational?: boolean;
  systemInstruction?: string;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  mcpServers: unknown[];
  conversationId?: string;
  mode: 'accept-edits' | 'plan';
  activeAbortController: AbortController | null;
  /** Highest complexity tier this conversation has needed; it never routes below it. */
  routerTier?: Tier;
  /** Caller-provided `_meta` from session/new (e.g. a default tier hint). */
  meta?: unknown;
  /** Model that served the previous turn, used to announce routing changes. */
  lastModel?: string;
}
