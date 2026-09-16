# Antigravity ACP Server (`gemini-acp-server`)

A high-performance, minimalist **Agent Client Protocol (ACP)** server that interfaces ACP-compliant code editors (such as **Zed**, **JetBrains**, or custom **Vercel AI SDK** clients) directly with the **Antigravity CLI** (`agy`).

---

## Architecture

The server acts as a bidirectional JSON-RPC 2.0 bridge communicating over standard input/output (`stdio`), orchestrating the Antigravity CLI via its deterministic NDJSON stream (`--output-format stream-json`).

```
+---------------------------+             +---------------------------------------+             +-------------------------+
|        ACP Client         |  JSON-RPC   |        Antigravity ACP Server         |  Subprocess |     Antigravity CLI     |
| (Zed / IDE / Web Panel)   |<---stdio--->|      (Node.js / TypeScript Bridge)    |<---NDJSON---|         ('agy')         |
|                           |             |                                       |             |                         |
| - session/new             |             | - Session Manager (state & conv IDs)  |             | - Gemini / Claude LLMs  |
| - session/prompt          |             | - Stream Parser & Event Translator    |             | - Tool execution        |
| - session/cancel          |             | - Capability & Mode Negotiator        |             | - Subagents & planning  |
+---------------------------+             +---------------------------------------+             +-------------------------+
```

### Event Translation Matrix

| `agy` Stream Event | ACP Client Notification (`session/update`) |
| :--- | :--- |
| `step_update` (type: `agent_response`, `text_delta`) | `agent_message_chunk` |
| `step_update` (type: `tool`, state: `ACTIVE`) | `tool_call` (`kind`, `locations`, `rawInput`) |
| `step_update` (type: `tool`, state: `DONE`) | `tool_call_update` (`status`, `rawOutput`) |
| `step_update` (`usage`) | `usage_update` (`inputTokens`, `outputTokens`, `cacheReadTokens`) |
| `result` (`conversation_id`) | Updates session state with conversation persistence ID |

---

## Features

- **Standard I/O JSON-RPC 2.0 Transport**: Fully compliant with the official `@agentclientprotocol/sdk` v1.x standard.
- **NDJSON Stream Transformation**: Real-time streaming of model thoughts, responses, tool calls, and completion states without buffering delays.
- **Multi-Turn Conversation Persistence**: Captures `conversation_id` on the first turn and supplies `--conversation <id>` on subsequent turns within the same ACP session.
- **Execution Modes**: Supports switching between `accept-edits` and `plan` modes dynamically via `session/set_mode`.
- **Cancellation & Process Management**: Gracefully intercepts `session/cancel` or client disconnects to abort background `agy` processes (`SIGTERM` followed by cleanup).
- **Zero Bloat**: Lightweight TypeScript runtime, zero unnecessary daemon layers, strictly decoupled architecture.

---

## Prerequisites

- **Node.js**: `v20.x` or later (tested on Node v26)
- **Antigravity CLI (`agy`)**: Installed and authenticated in your PATH (or specified via `--binary`)

---

## Installation & Build

```bash
# Clone or navigate to the project directory
cd "/home/prime/Projects/Gemini ACP Server"

# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Run test suite
npm test
```

---

## Integration with Zed Editor

Add the server to your Zed `settings.json` under `agent_servers`:

```json
{
  "agent_servers": {
    "Antigravity": {
      "command": "node",
      "args": ["/home/prime/Projects/Gemini ACP Server/dist/cli.js"],
      "env": {
        "AGY_PATH": "/home/prime/Coding-Agents/bin/agy",
        "AGY_EFFORT": "high"
      }
    }
  }
}
```

Once configured, restart or reload Zed and open the Agent Panel. **Antigravity** will appear as an available agent provider.

---

## CLI Options & Environment Variables

You can run the executable directly or pass configuration flags:

```bash
node dist/cli.js [options]
```

| Flag | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--binary <path>` | `AGY_PATH` | `agy` | Path to the `agy` CLI binary |
| `--model <name>` | `AGY_MODEL` | `undefined` | Target model override for turns |
| `--effort <level>`| `AGY_EFFORT` | `undefined` | Reasoning effort (`low`, `medium`, `high`) |
| `--debug` | `AGY_DEBUG` | `false` | Writes debug diagnostic traces to `stderr` |

*Note: All diagnostic and error logging is sent exclusively to `stderr` to ensure stdout remains completely clean for JSON-RPC message framing.*

---

## Testing

```bash
# Run unit tests
npm test

# Run TypeScript type verification
npm run typecheck

# Test stdio handshake manually
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n' | node dist/cli.js
```

---

## License

Apache-2.0
