import { describe, it, expect, jest } from '@jest/globals';
import {
  AcpBridge,
  extractPromptText,
  inferToolKind,
  extractLocations,
  type ClientConnection,
} from '../acp-bridge.js';
import type { AgyRunner } from '../agy-process.js';
import type { AgyStreamEvent, SpawnTurnOptions } from '../types.js';

describe('AcpBridge', () => {
  describe('extractPromptText', () => {
    it('extracts plain text from text blocks', () => {
      const blocks = [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
      ];
      expect(extractPromptText(blocks)).toBe('First block\nSecond block');
    });

    it('extracts resource links', () => {
      const blocks = [{ type: 'resource_link', uri: 'file:///app.ts' }];
      expect(extractPromptText(blocks)).toBe('[Resource: file:///app.ts]');
    });

    it('handles embedded resource blocks', () => {
      const blocks = [
        { type: 'resource', resource: { text: 'code content here' } },
      ];
      expect(extractPromptText(blocks)).toBe('code content here');
    });

    it('returns empty string for non-array input', () => {
      expect(extractPromptText(null as any)).toBe('');
    });
  });

  describe('inferToolKind', () => {
    it('categorizes read tools', () => {
      expect(inferToolKind('view_file')).toBe('read');
      expect(inferToolKind('read_resource')).toBe('read');
      expect(inferToolKind('grep_search')).toBe('read');
      expect(inferToolKind('list_dir')).toBe('read');
    });

    it('categorizes edit tools', () => {
      expect(inferToolKind('write_to_file')).toBe('edit');
      expect(inferToolKind('replace_file_content')).toBe('edit');
      expect(inferToolKind('sed_file')).toBe('edit');
    });

    it('categorizes execute tools', () => {
      expect(inferToolKind('run_command')).toBe('execute');
    });

    it('falls back to other for unknown tools', () => {
      expect(inferToolKind('custom_unknown_action')).toBe('other');
      expect(inferToolKind(undefined)).toBe('other');
    });
  });

  describe('extractLocations', () => {
    it('extracts path parameters', () => {
      expect(extractLocations({ TargetFile: '/src/main.ts' })).toEqual([
        { path: '/src/main.ts' },
      ]);
      expect(extractLocations({ AbsolutePath: '/src/index.ts' })).toEqual([
        { path: '/src/index.ts' },
      ]);
    });

    it('returns empty array when no path found', () => {
      expect(extractLocations({ query: 'search' })).toEqual([]);
      expect(extractLocations(undefined)).toEqual([]);
    });
  });

  describe('Session Management & Lifecycle', () => {
    it('initializes capabilities successfully', async () => {
      const bridge = new AcpBridge();
      const res = await bridge.initialize();
      expect(res.protocolVersion).toBeDefined();
      expect(res.agentCapabilities.loadSession).toBe(false);
    });

    it('creates a new session with configuration', async () => {
      const bridge = new AcpBridge();
      const res = await bridge.newSession({
        cwd: '/test/workspace',
        additionalDirectories: ['/test/extra'],
        mcpServers: [],
      });

      expect(res.sessionId).toBeDefined();
      const session = bridge.getSession(res.sessionId);
      expect(session).toBeDefined();
      expect(session?.cwd).toBe('/test/workspace');
      expect(session?.additionalDirectories).toContain('/test/extra');
      expect(session?.mode).toBe('accept-edits');
    });

    it('switches session mode and notifies client', async () => {
      const bridge = new AcpBridge();
      const sessionRes = await bridge.newSession({ cwd: '/test' });

      const notifications: Array<{ method: string; params: any }> = [];
      const mockClient: ClientConnection = {
        notify: async (method, params) => {
          notifications.push({ method, params });
        },
        request: async () => ({}),
      };

      await bridge.setSessionMode(
        { sessionId: sessionRes.sessionId, modeId: 'plan' },
        mockClient,
      );

      const session = bridge.getSession(sessionRes.sessionId);
      expect(session?.mode).toBe('plan');
      expect(notifications.length).toBe(1);
      expect(notifications[0]?.params.update.currentModeId).toBe('plan');
    });

    it('handles prompt execution and updates client with streamed events', async () => {
      const notifications: Array<{ method: string; params: any }> = [];
      const mockClient: ClientConnection = {
        notify: async (method, params) => {
          notifications.push({ method, params });
        },
        request: async () => ({}),
      };

      const mockRunner: Partial<AgyRunner> = {
        runTurn: jest.fn((_options: unknown, onEvent: (e: AgyStreamEvent) => void | Promise<void>) => {
          const promise = (async () => {
            // Simulate agent message delta
            const event1: AgyStreamEvent = {
              event: 'step_update',
              step_update: {
                conversation_id: 'conv-abc',
                step_index: 1,
                state: 'ACTIVE',
                step_type: 'agent_response',
                text_delta: 'Thinking through solution...',
              },
            };
            await onEvent(event1);

            // Simulate tool execution
            const event2: AgyStreamEvent = {
              event: 'step_update',
              step_update: {
                conversation_id: 'conv-abc',
                step_index: 2,
                state: 'ACTIVE',
                step_type: 'tool',
                tool_name: 'view_file',
                tool_info: {
                  name: 'view_file',
                  parameters: { AbsolutePath: '/test/file.ts' },
                },
              },
            };
            await onEvent(event2);

            const event3: AgyStreamEvent = {
              event: 'step_update',
              step_update: {
                conversation_id: 'conv-abc',
                step_index: 2,
                state: 'DONE',
                step_type: 'tool',
                tool_name: 'view_file',
                tool_info: {
                  name: 'view_file',
                  output: 'file contents',
                },
              },
            };
            await onEvent(event3);

            return {
              conversationId: 'conv-abc',
              exitCode: 0,
            };
          })();

          return {
            promise,
            abort: () => {},
          };
        }) as any,
      };

      const bridge = new AcpBridge(mockRunner as AgyRunner);
      const sessionRes = await bridge.newSession({ cwd: '/test' });

      const promptRes = await bridge.prompt(
        {
          sessionId: sessionRes.sessionId,
          prompt: [{ type: 'text', text: 'Implement feature' }],
        },
        mockClient,
      );

      expect(promptRes.stopReason).toBe('end_turn');

      // Verify conversationId was saved to the session
      const session = bridge.getSession(sessionRes.sessionId);
      expect(session?.conversationId).toBe('conv-abc');

      // Verify streamed notifications were sent to client
      expect(notifications.length).toBeGreaterThanOrEqual(3);
      const types = notifications.map((n) => n.params.update.sessionUpdate);
      expect(types).toContain('agent_message_chunk');
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_call_update');
    });

    it('cancels active turn when cancel request is received', async () => {
      let aborted = false;
      const mockRunner: Partial<AgyRunner> = {
        runTurn: jest.fn((options: SpawnTurnOptions) => {
          return {
            promise: new Promise((resolve) => {
              options.signal?.addEventListener('abort', () => {
                aborted = true;
                resolve({ exitCode: null });
              });
            }),
            abort: () => {},
          };
        }) as any,
      };

      const bridge = new AcpBridge(mockRunner as AgyRunner);
      const sessionRes = await bridge.newSession({ cwd: '/test' });

      const mockClient: ClientConnection = {
        notify: async () => {},
        request: async () => ({}),
      };

      const promptPromise = bridge.prompt(
        {
          sessionId: sessionRes.sessionId,
          prompt: [{ type: 'text', text: 'Long task' }],
        },
        mockClient,
      );

      await bridge.cancel({ sessionId: sessionRes.sessionId });

      const result = await promptPromise;
      expect(result.stopReason).toBe('cancelled');
      expect(aborted).toBe(true);
    });
  });
});
