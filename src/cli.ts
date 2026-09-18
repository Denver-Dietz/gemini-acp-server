#!/usr/bin/env node
import { createAcpServer } from './server.js';
import type { ServerOptions } from './types.js';

function parseArgs(args: string[]): ServerOptions {
  const options: ServerOptions = {
    binaryPath: process.env['AGY_PATH'] || 'agy',
    defaultModel: process.env['AGY_MODEL'],
    defaultEffort: (process.env['AGY_EFFORT'] as any) || 'medium',
    debug: process.env['AGY_DEBUG'] === '1' || process.env['DEBUG'] === '1',
    contextTrimming: process.env['AGY_CONTEXT_TRIMMING'] !== '0',
    mcpGating: process.env['AGY_MCP_GATING'] !== '0',
    conversational: process.env['AGY_CONVERSATIONAL'] !== '0',
    systemInstruction: process.env['AGY_SYSTEM_INSTRUCTION'],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--binary' && i + 1 < args.length) {
      options.binaryPath = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      options.defaultModel = args[++i];
    } else if (arg === '--effort' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'low' || val === 'medium' || val === 'high') {
        options.defaultEffort = val;
      }
    } else if (arg === '--instruction' || arg === '--system-instruction') {
      if (i + 1 < args.length) {
        options.systemInstruction = args[++i];
      }
    } else if (arg === '--conversational') {
      options.conversational = true;
    } else if (arg === '--no-conversational') {
      options.conversational = false;
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--no-context-trimming') {
      options.contextTrimming = false;
    } else if (arg === '--no-mcp-gating') {
      options.mcpGating = false;
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(`
Antigravity ACP Server (gemini-acp-server)

Usage:
  gemini-acp-server [options]

Options:
  --binary <path>          Path to agy CLI executable (default: 'agy' or AGY_PATH)
  --model <name>           Default model to forward to agy (default: AGY_MODEL)
  --effort <level>         Reasoning effort: low, medium, high (default: medium or AGY_EFFORT)
  --instruction <text>     Custom system instruction or communication directive
  --conversational         Enable conversational collaboration mode (default: true)
  --no-conversational      Disable conversational prompt shaping
  --no-context-trimming    Disable smart whitespace/transcript/file-dump trimming
  --no-mcp-gating          Disable dynamic MCP tool namespace suppression
  --debug                  Enable debug logs to stderr
  --help, -h               Show this help message

Standard I/O:
  Runs an ACP-compliant JSON-RPC server reading requests from stdin and
  writing responses and notifications to stdout.
\n`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.debug) {
    process.stderr.write(`[gemini-acp] Starting server with binary: ${options.binaryPath}\n`);
  }

  try {
    const server = createAcpServer(options);
    await server.startStdio();
  } catch (err) {
    process.stderr.write(`[gemini-acp] Fatal error: ${err}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[gemini-acp] Unhandled error: ${err}\n`);
  process.exit(1);
});
