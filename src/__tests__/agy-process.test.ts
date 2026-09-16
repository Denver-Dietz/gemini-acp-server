import { describe, it, expect } from '@jest/globals';
import { parseAgyEvent, buildAgyArgs } from '../agy-process.js';

describe('AgyProcess', () => {
  describe('parseAgyEvent', () => {
    it('returns null for empty or whitespace lines', () => {
      expect(parseAgyEvent('')).toBeNull();
      expect(parseAgyEvent('   \n\t')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseAgyEvent('not-a-json')).toBeNull();
      expect(parseAgyEvent('{invalid: json')).toBeNull();
    });

    it('parses an init event correctly', () => {
      const line = JSON.stringify({
        event: 'init',
        conversation_id: 'conv-123',
        init: {
          cwd: '/path/to/project',
          tools: ['run_command', 'view_file'],
          permission_mode: 'always-proceed',
        },
      });

      const parsed = parseAgyEvent(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.event).toBe('init');
      if (parsed && parsed.event === 'init') {
        expect(parsed.conversation_id).toBe('conv-123');
        expect(parsed.init.tools).toContain('run_command');
      }
    });

    it('parses a step_update event correctly', () => {
      const line = JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Hello world',
        },
      });

      const parsed = parseAgyEvent(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.event).toBe('step_update');
      if (parsed && parsed.event === 'step_update') {
        expect(parsed.step_update.text_delta).toBe('Hello world');
        expect(parsed.step_update.state).toBe('ACTIVE');
      }
    });

    it('parses a result event correctly', () => {
      const line = JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          response: 'Task complete',
          num_turns: 1,
        },
      });

      const parsed = parseAgyEvent(line);
      expect(parsed).not.toBeNull();
      expect(parsed?.event).toBe('result');
      if (parsed && parsed.event === 'result') {
        expect(parsed.result.status).toBe('SUCCESS');
        expect(parsed.result.response).toBe('Task complete');
      }
    });
  });

  describe('buildAgyArgs', () => {
    it('constructs basic agy arguments with stream-json format', () => {
      const args = buildAgyArgs({
        prompt: 'test prompt',
        cwd: '/test/cwd',
      });

      expect(args).toEqual([
        '-p',
        'test prompt',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
      ]);
    });

    it('includes optional conversation, mode, model, and effort flags', () => {
      const args = buildAgyArgs({
        prompt: 'test prompt',
        cwd: '/test/cwd',
        conversationId: 'conv-999',
        mode: 'plan',
        model: 'gemini-2.5-pro',
        effort: 'high',
        additionalDirectories: ['/extra/dir1', '/extra/dir2'],
      });

      expect(args).toContain('--conversation');
      expect(args).toContain('conv-999');
      expect(args).toContain('--mode');
      expect(args).toContain('plan');
      expect(args).toContain('--model');
      expect(args).toContain('gemini-2.5-pro');
      expect(args).toContain('--effort');
      expect(args).toContain('high');
      expect(args).toContain('--add-dir');
      expect(args).toContain('/extra/dir1');
      expect(args).toContain('/extra/dir2');
    });
  });
});
