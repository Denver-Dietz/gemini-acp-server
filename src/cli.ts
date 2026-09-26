#!/usr/bin/env node
import { AgyRunner } from './agy-process.js';
import { loadRouterConfig } from './router/config.js';
import { checkModels, formatRouterStatus } from './router/diagnostics.js';
import { ModelHealth } from './router/model-health.js';
import { ModelRouter } from './router/router.js';
import { createAcpServer } from './server.js';
import type { ServerOptions } from './types.js';

interface CliMode {
  routerFlag?: boolean;
  status?: boolean;
  check?: boolean;
  checkModels?: string[];
}

function parseArgs(args: string[], mode: CliMode = {}): ServerOptions {
  const options: ServerOptions = {
    binaryPath: process.env['AGY_PATH'] || 'agy',
    defaultModel: process.env['AGY_MODEL'],
    defaultEffort: (process.env['AGY_EFFORT'] as any) || 'medium',
    debug: process.env['AGY_DEBUG'] === '1' || process.env['DEBUG'] === '1',
    contextTrimming: process.env['AGY_CONTEXT_TRIMMING'] !== '0',
    mcpGating: process.env['AGY_MCP_GATING'] !== '0',
    mcpMode: (['auto', 'none', 'all'].includes(process.env['AGY_MCP_MODE'] ?? '') ? process.env['AGY_MCP_MODE'] : 'auto') as 'auto' | 'none' | 'all',
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
    } else if (arg === '--router') {
      mode.routerFlag = true;
    } else if (arg === '--no-router') {
      mode.routerFlag = false;
    } else if (arg === '--router-status') {
      mode.status = true;
    } else if (arg === '--check-models') {
      mode.check = true;
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        mode.checkModels = next.split(',').map((m) => m.trim()).filter(Boolean);
        i++;
      }
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--no-context-trimming') {
      options.contextTrimming = false;
    } else if (arg === '--mcp' && i + 1 < args.length) {
      const v = args[++i];
      if (v === 'auto' || v === 'none' || v === 'all') options.mcpMode = v;
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
  --mcp <auto|none|all>    MCP servers per turn: gate by prompt keywords (default), start none, or all
  --router / --no-router   Route each turn to a model by complexity and availability (default: on
                           unless a model is pinned with --model / AGY_MODEL)
  --router-status          Show the model ladders and which models are currently blocked
  --check-models [a,b,c]   Test each model with a tiny prompt and record availability + reset times
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

function buildRouter(options: ServerOptions, mode: CliMode): ModelRouter | null {
  const envFlag = process.env['AGY_ROUTER'];
  const explicit = mode.routerFlag ?? (envFlag === '1' ? true : envFlag === '0' ? false : undefined);
  const pinned = Boolean(options.defaultModel);
  // an explicitly chosen model means "use exactly this one" unless routing was asked for
  const enabled = explicit ?? !pinned;
  if (!enabled) return null;
  const cfg = loadRouterConfig();
  return new ModelRouter(cfg, new ModelHealth(cfg.healthFile));
}

async function main() {
  const mode: CliMode = {};
  const options = parseArgs(process.argv.slice(2), mode);
  const router = buildRouter(options, mode);
  if (mode.status || mode.check) {
    const active = router ?? new ModelRouter(loadRouterConfig(), new ModelHealth(loadRouterConfig().healthFile));
    if (mode.check) {
      process.stderr.write('Testing models (each can take up to a few minutes when a quota is exhausted)...\n');
      await checkModels(new AgyRunner(options.binaryPath ?? 'agy'), active, mode.checkModels, process.cwd(), 3, (l) => process.stderr.write(`${l}\n`));
      process.stderr.write('\n');
    }
    process.stderr.write(`${formatRouterStatus(active)}\n`);
    process.exit(0);
  }
  options.router = router;

  if (options.debug) {
    process.stderr.write(
      `[gemini-acp] Starting server with binary: ${options.binaryPath}; ` +
        `${router ? 'model routing ON' : `model pinned: ${options.defaultModel ?? 'agy default'}`}\n`,
    );
  }

  const server = createAcpServer(options);
  try {
    await server.startStdio();
  } catch (err) {
    process.stderr.write(`[gemini-acp] Fatal error: ${err}\n`);
    process.exit(1);
  } finally {
    await server.bridge.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[gemini-acp] Unhandled error: ${err}\n`);
  process.exit(1);
});
