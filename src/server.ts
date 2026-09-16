import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { AcpBridge } from './acp-bridge.js';
import { AgyRunner } from './agy-process.js';
import type { ServerOptions } from './types.js';

export function createAcpServer(options: ServerOptions = {}) {
  const runner = new AgyRunner(options.binaryPath ?? 'agy');
  const bridge = new AcpBridge(runner, options);

  const agentApp = acp
    .agent({ name: 'gemini-acp-server' })
    .onRequest('initialize', (ctx) => bridge.initialize(ctx.params))
    .onRequest('authenticate', (ctx) => bridge.authenticate(ctx.params))
    .onRequest('session/new', (ctx) => bridge.newSession(ctx.params as any))
    .onRequest('session/set_mode', (ctx) =>
      bridge.setSessionMode(ctx.params as any, ctx.client),
    )
    .onRequest('session/prompt', (ctx) =>
      bridge.prompt(ctx.params as any, ctx.client),
    )
    .onNotification('session/cancel', (ctx) =>
      bridge.cancel(ctx.params as any),
    );

  const startStdio = () => {
    // Write out through stdout, read incoming requests through stdin
    const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    return agentApp.connect(stream);
  };

  return {
    agentApp,
    bridge,
    runner,
    startStdio,
  };
}
