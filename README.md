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
- **Model Routing & Limit Fallthrough**: starts each conversation on the cheapest model, escalates to stronger models only for complex work, and skips models that are rate-limited, out of capacity, or stalled (see below).
- **Zero Bloat**: Lightweight TypeScript runtime, zero unnecessary daemon layers, strictly decoupled architecture.
- **Shared AutoComp and Memory Adapter**: Session lifecycle and compact checkpoints flow through the existing platform adapter boundary asynchronously; MemoryBridge remains the canonical writer and GraphRAG remains read-only from this process.

---

## Prerequisites

- **Node.js**: `v20.x` or later (tested on Node v26)
- **Antigravity CLI (`agy`)**: Installed and authenticated in your PATH (or specified via `--binary`)

---

## Installation & Build

```bash
# Clone or navigate to the project directory
cd "/home/prime/Coding-Agents/Gemini-ACP-Server"

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
      "args": ["/home/prime/Coding-Agents/Gemini-ACP-Server/dist/cli.js"],
      "env": {
        "AGY_PATH": "/home/prime/Coding-Agents/Antigravity/antigravity-cli/agy",
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
| `--instruction <text>` | `AGY_SYSTEM_INSTRUCTION` | `undefined` | Custom system instruction / directive |
| `--conversational` | `AGY_CONVERSATIONAL` | `true` | Enables conversational collaboration mode |
| `--no-conversational` | `AGY_CONVERSATIONAL=0` | `false` | Disables conversational prompt shaping |
| `--debug` | `AGY_DEBUG` | `false` | Writes debug diagnostic traces to `stderr` |

### Platform continuity adapter

When the shared boundary exists, the server uses `/home/prime/Platform/AutoComp-HarnessAdapters/autocomp-adapter.py` automatically. It emits bounded lifecycle events (`session_start` and one checkpoint per successful turn); the ACP prompt and stream never wait for Python, MemoryBridge, or GraphRAG. Adapter failures are fail-open.

| Environment variable | Default | Description |
| :--- | :--- | :--- |
| `GEMINI_ACP_MEMORY_ADAPTER` | enabled when the shared script exists | Set to `0` to disable lifecycle events |
| `GEMINI_ACP_AUTOCOMP_ADAPTER` | platform adapter path | Override the shared adapter boundary |
| `GEMINI_ACP_ADAPTER_TIMEOUT_MS` | `250` | Maximum wait per background adapter event |
| `GEMINI_ACP_HARNESS` | `antigravity` | Integration identity passed to the generic adapter |

*Note: All diagnostic and error logging is sent exclusively to `stderr` to ensure stdout remains completely clean for JSON-RPC message framing.*

---

## Model Routing & Fallthrough

By default (no `--model`/`AGY_MODEL` pinned) every turn is routed:

1. **Complexity picks a tier.** An explicit hint wins (`_meta.agyRouter.tier` = `low|mid|high` or `0|1|2` on `session/new` or `session/prompt`); otherwise a local scorer (prompt size, architecture/trade-off/concurrency/migration cues, plan decomposition, list items, stack traces, referenced files) picks one, biased toward the cheap tier. A conversation never drops below the highest tier it has used.
2. **The tier's ladder gives the order** (first available wins; override in `router.json`):

| Tier | Ladder |
| :--- | :--- |
| 0 simple | `gemini-3.8-flash-low`, `gemini-3.7-flash-low`, `gemini-3.6-flash-low`, `gpt-oss-120b-medium`, `claude-sonnet-4-6` |
| 1 moderate | `gemini-3.8-flash-high`, `gemini-3.1-pro-low`, `gpt-oss-120b-medium`, `claude-sonnet-4-6` |
| 2 complex | `gemini-3.1-pro-high`, `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gpt-oss-120b-medium` |

3. **Failures are classified and remembered** (`~/.cache/gemini-acp-server/model-health.json`, so a weekly limit survives restarts):
   - `RESOURCE_EXHAUSTED (429)` quota: blocked until the reset time in the message (e.g. `Resets in 98h29m44s`), else 5h -> 24h -> 7d. Other models in the same family that have not worked recently become *suspect* (30m -> 2h -> 6h -> 24h) so one exhausted pool does not cost minutes of retries per model.
   - `UNAVAILABLE (503)` "No capacity": short (2 min) cooldown - a blip, not a quota.
   - Claude and GPT-OSS are treated as one shared budget (a 5-hour limit on one marks the other suspect).
   - No output within the stall window: 10 min cooldown. Auth errors stop the turn (they affect every model).
4. **The turn falls through** to the next available model. A turn is only retried if no output reached the client; routing decisions are sent as `agent_thought_chunk` notices (`[router] ...`), never mixed into the answer. If every model is blocked the error lists each one and when it returns.

```bash
node dist/cli.js --router-status            # ladders and which models are blocked, and for how long
node dist/cli.js --check-models             # tiny prompt to every model; records real availability/reset times
node dist/cli.js --check-models gpt-oss-120b-medium,claude-sonnet-4-6
node dist/cli.js --no-router --model claude-sonnet-4-6   # pin one model
```

Config: `AGY_ROUTER=0|1`, `AGY_ROUTER_CONFIG=<json>` (default `~/.config/gemini-acp-server/router.json`; partial overrides of `tiers`, `thresholds`, `cooldowns`, `stallTimeoutMs`, `maxAttempts`), `AGY_ROUTER_HEALTH=<file|memory>`. Switching models inside one conversation keeps the conversation (`--conversation` is preserved).

## MCP Servers per Turn

`agy` starts every configured MCP server (`~/.gemini/config/mcp_config.json`) at the beginning of every turn and waits for them to initialize. Measured with 14 servers configured: a one-word turn took **~38 s**; with no servers configured it took **~5 s** (the model itself answers in ~1.6 s). Note `agy` still launches servers marked `"disabled": true`, so the server removes unwanted servers from a scoped config rather than flagging them.

| Mode | Behavior |
| :--- | :--- |
| `auto` (default) | Removes heavy and inherited platform servers whose domain the prompt does not mention (browser, database, notebooks, Overlord/Magic, sentry, ...) |
| `none` | Removes every server. Use for machine-driven calls (sent by default for machine-generated turns) |
| `all` | Real config, untouched |

Set per session/turn with `_meta.agyRouter.mcp` (or `_meta.mcp`), or globally with `--mcp <mode>` / `AGY_MCP_MODE`.

In `auto`, the inherited local platform servers (`magic-hyperlambda`, `overlord-context`, and `overlord-capabilities`) are opt-in. Mentioning Magic, Hyperlambda, Overlord, capabilities, or context activates that general domain. Use `all` only when the full inherited MCP catalogue is needed; use `none` for machine-generated turns.

MCP config parsing is cached by file signature, and reusable scoped homes are refreshed only when the source `.gemini` directories change. This keeps the per-turn routing decision in the sub-millisecond range after warm-up while preserving config changes.

The scoped config lives in a **persistent, reusable home** (`~/.gemini-acp-server/scoped-homes/<hash>`, keyed by the config content plus the removed set) that symlinks the real `.gemini` state and the shared `.npm`, `.cache`, `.config`, `.local`, `.ssh` and `.gitconfig`. Nothing is created or deleted per turn, so `/tmp` is never used and parallel turns cannot delete each other's home. (The previous per-turn `/tmp/gemini-acp-mcp-*` homes each accumulated a private ~500 MB npm cache and filled the RAM-backed `/tmp`.)

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
