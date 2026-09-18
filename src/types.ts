/**
 * Core type definitions for Antigravity ACP Server.
 */

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
  conversational?: boolean;
  systemInstruction?: string;
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
}
