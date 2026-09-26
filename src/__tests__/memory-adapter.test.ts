import fs from 'node:fs';
import { AutoCompAdapter } from '../autocomp-adapter.js';
import { MemoryAdapter } from '../memory-adapter.js';

describe('platform lifecycle adapters', () => {
  it('fail closed without spawning when disabled', () => {
    const adapter = new AutoCompAdapter({ enabled: false, scriptPath: '/does/not/exist' });
    expect(() => adapter.emit({ event: 'checkpoint', sessionId: 's', cwd: '/tmp' })).not.toThrow();
  });

  it('uses the shared adapter boundary without requiring local files', () => {
    const adapter = new MemoryAdapter({ enabled: false, scriptPath: '/does/not/exist' });
    expect(() => {
      adapter.sessionStart({ sessionId: 's', cwd: fs.realpathSync('/tmp') });
      adapter.checkpoint({ sessionId: 's', cwd: '/tmp', prompt: 'small task' });
      adapter.sessionEnd({ sessionId: 's', cwd: '/tmp', status: 'done' });
    }).not.toThrow();
  });
});
