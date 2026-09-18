import fs from 'node:fs';
import path from 'node:path';

export interface ContextTrimmerOptions {
  cwd?: string;
  isOngoingSession?: boolean;
  maxDumpLines?: number;
}

/**
 * Normalizes newlines, strips trailing spaces, and collapses excessive blank lines.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Intercepts massive base64 payloads and minified single-line blobs to prevent token exhaustion.
 * Combined regex: handles base64 URLs and minified blobs in a single pass.
 */
export function guardLargeBlobs(text: string): string {
  if (!text) return '';

  return text
    .replace(
      /data:([a-zA-Z0-9/+-]+);base64,([a-zA-Z0-9+/=]{120,})/g,
      (_match, mime, b64) => `[Embedded binary payload: ${mime} (${Math.round((b64.length * 3) / 4)} bytes)]`,
    )
    .replace(/[^\s]{4000,}/g, (match) => {
      return `${match.slice(0, 160)}... [Truncated minified token blob: ${match.length} characters]`;
    });
}

/**
 * When continuing an existing conversation, strips repeated historical turns sent by some ACP clients.
 */
export function stripRedundantDialogue(text: string, isOngoingSession: boolean): string {
  if (!text || !isOngoingSession) return text;

  // Check for chat-transcript prefix patterns (e.g. "User: ... \nAssistant: ... \nUser: ...")
  const userTurnMatches = [...text.matchAll(/(?:^|\n)(?:User|Human):\s+/gi)];
  if (userTurnMatches.length >= 2) {
    const lastMatch = userTurnMatches[userTurnMatches.length - 1];
    if (lastMatch && typeof lastMatch.index === 'number') {
      const matchLen = lastMatch[0].length;
      const lastTurnText = text.slice(lastMatch.index + matchLen).trim();
      if (lastTurnText) {
        return lastTurnText;
      }
    }
  }

  return text;
}

/**
 * Detects embedded full-file dumps of files already present in the workspace
 * and condenses them into lightweight disk references.
 * Fast-path: check line count before filesystem ops (defer FS checks).
 */
export function deDuplicateFileDumps(
  text: string,
  cwd?: string,
  maxDumpLines = 60,
): string {
  if (!text || !cwd) return text;

  // Regex for blocks formatted as: "File: <path>\n```...\n```" or similar
  const codeBlockRegex = /(?:^|\n)(?:File:\s*|Path:\s*|#\s*)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)\s*\n```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;

  return text.replace(codeBlockRegex, (match, filePath, codeContent) => {
    const lines = codeContent.trim().split('\n');
    // Fast-path: if content is small, keep it (skip FS check)
    if (lines.length <= maxDumpLines) {
      return match;
    }

    // Only check filesystem for large blocks
    try {
      const targetPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath);

      if (fs.existsSync(targetPath)) {
        const relPath = path.relative(cwd, targetPath);
        return `\n[Context: ${relPath} (${lines.length} lines on disk - accessible via ViewFile/GrepSearch)]`;
      }
    } catch {
      // If filesystem check fails, retain original text
    }
    return match;
  });
}

/**
 * Primary Context-Filtering Middleware.
 * Intercepts raw ACP prompt blocks and produces an optimized prompt payload.
 * Optimized: reduced passes, fast-path for small files, deferred FS checks.
 */
export function trimPromptBlocks(
  blocks: unknown[],
  options: ContextTrimmerOptions = {},
): string {
  if (!Array.isArray(blocks)) {
    return '';
  }

  const cwd = options.cwd ?? process.cwd();
  const maxDumpLines = options.maxDumpLines ?? 60;
  const isOngoingSession = options.isOngoingSession ?? false;

  const extracted = blocks
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
        const uri = typeof res.uri === 'string' ? res.uri : '';
        const content = typeof res.text === 'string' ? res.text : '';

        if (uri && content) {
          const lines = content.split('\n');
          // If the resource references a local file on disk exceeding maxDumpLines, trim it
          if (uri.startsWith('file://')) {
            const filePath = uri.replace('file://', '');
            if (fs.existsSync(filePath) && lines.length > maxDumpLines) {
              const rel = path.relative(cwd, filePath);
              return `[Resource: ${rel} (${lines.length} lines on disk - accessible via ViewFile)]`;
            }
          }
        }
        return content;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  // Optimized pipeline: normalize → guard → dedupe → dialogue strip (order matters for efficiency)
  // Normalizing first ensures consistent whitespace before expensive operations
  let processed = normalizeText(extracted);

  // Guard large blobs and dedupe file dumps in separate passes (can't combine safely)
  processed = guardLargeBlobs(processed);
  processed = deDuplicateFileDumps(processed, cwd, maxDumpLines);

  // Only strip dialogue if needed (optional pass)
  if (isOngoingSession) {
    processed = stripRedundantDialogue(processed, true);
  }

  // Final normalize to clean up any whitespace from replacements
  return normalizeText(processed);
}
