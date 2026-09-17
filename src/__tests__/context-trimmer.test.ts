import {
  normalizeText,
  guardLargeBlobs,
  stripRedundantDialogue,
  deDuplicateFileDumps,
  trimPromptBlocks,
} from '../context-trimmer.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ContextTrimmer', () => {
  describe('normalizeText', () => {
    it('normalizes CRLF to LF and strips trailing spaces', () => {
      const input = 'hello   \r\nworld  \r\n\n\n\n\nfoo';
      const expected = 'hello\nworld\n\nfoo';
      expect(normalizeText(input)).toBe(expected);
    });

    it('returns empty string for empty input', () => {
      expect(normalizeText('')).toBe('');
    });
  });

  describe('guardLargeBlobs', () => {
    it('truncates base64 data URLs', () => {
      const b64Data = 'data:image/png;base64,' + 'A'.repeat(200);
      const result = guardLargeBlobs(`Here is an image: ${b64Data}`);
      expect(result).toContain('[Embedded binary payload: image/png (150 bytes)]');
      expect(result).not.toContain('AAAAA');
    });

    it('truncates huge minified single-line tokens', () => {
      const hugeToken = 'x'.repeat(5000);
      const result = guardLargeBlobs(`Code: ${hugeToken}`);
      expect(result).toContain('[Truncated minified token blob: 5000 characters]');
    });
  });

  describe('stripRedundantDialogue', () => {
    it('leaves single-turn dialogues intact', () => {
      const prompt = 'User: Please refactor this function';
      expect(stripRedundantDialogue(prompt, true)).toBe('User: Please refactor this function');
    });

    it('extracts only the newest user turn when continuing an ongoing session', () => {
      const transcript = `User: First question\nAssistant: Here is the answer\nUser: Second follow up directive`;
      const result = stripRedundantDialogue(transcript, true);
      expect(result).toBe('Second follow up directive');
    });

    it('does not strip historical dialogue when isOngoingSession is false', () => {
      const transcript = `User: First question\nAssistant: Here is the answer\nUser: Second follow up directive`;
      const result = stripRedundantDialogue(transcript, false);
      expect(result).toBe(transcript);
    });
  });

  describe('deDuplicateFileDumps', () => {
    let tmpDir: string;
    let testFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimmer-test-'));
      testFile = path.join(tmpDir, 'large.ts');
      const lines = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join('\n');
      fs.writeFileSync(testFile, lines);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('condenses large existing workspace files into disk references', () => {
      const code = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join('\n');
      const prompt = `Inspect this file:\nlarge.ts\n\`\`\`typescript\n${code}\n\`\`\``;

      const result = deDuplicateFileDumps(prompt, tmpDir, 50);
      expect(result).toContain('[Context: large.ts (80 lines on disk - accessible via ViewFile/GrepSearch)]');
      expect(result).not.toContain('const line70');
    });

    it('retains code blocks below maxDumpLines threshold', () => {
      const smallCode = `const a = 1;\nconst b = 2;`;
      const prompt = `large.ts\n\`\`\`typescript\n${smallCode}\n\`\`\``;

      const result = deDuplicateFileDumps(prompt, tmpDir, 50);
      expect(result).toContain('const a = 1;');
    });
  });

  describe('trimPromptBlocks', () => {
    it('handles mixed blocks with text, resource, and resource_link', () => {
      const blocks = [
        { type: 'text', text: 'First instruction   \r\n\n\n\n' },
        { type: 'resource_link', uri: 'file:///workspace/app.ts' },
        {
          type: 'resource',
          resource: { uri: 'file:///nonexistent.ts', text: 'console.log("hello");' },
        },
      ];

      const result = trimPromptBlocks(blocks);
      expect(result).toContain('First instruction');
      expect(result).toContain('[Resource: file:///workspace/app.ts]');
      expect(result).toContain('console.log("hello");');
    });

    it('returns empty string for non-array input', () => {
      expect(trimPromptBlocks(null as any)).toBe('');
    });
  });
});
