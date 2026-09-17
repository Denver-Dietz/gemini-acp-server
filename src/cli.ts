#!/usr/bin/env node
import { createAcpServer } from './server.js';
import type { ServerOptions } from './types.js';

function parseArgs(args: string[]): ServerOptions {
  const options: ServerOptions = {
    binaryPath: process.env['AGY_PATH'] || 'agy',
    defaultModel: process.env['AGY_MODEL'],
    defaultEffort: (process.env['AGY_EFFORT'] as any) || 'medium',
    debug: process.env['AGY_DEBUG'] === '1' || process.env['DEBUG'] === '1',
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
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(`
Antigravity ACP Server (gemini-acp-server)

Usage:
  gemini-acp-server [options]

Options:
  --binary <path>    Path to agy CLI executable (default: 'agy' or AGY_PATH)
  --model <name>     Default model to forward to agy (default: AGY_MODEL)
  --effort <level>   Reasoning effort: low, medium, high (default: AGY_EFFORT)
  --debug            Enable debug logs to stderr
  --help, -h         Show this help message

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
