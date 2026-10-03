# clef-mcp

Local [MCP](https://modelcontextprotocol.io) server that gives coding agents (Codex, Claude Code, Cursor, …) access to the **Clef decision model** through a single structured tool: `clef_decide`.

```text
AI Agent
   ↓ MCP (stdio)
clef-mcp
   ↓ POST /v1/systemone
llama.cpp (llama-server, local)
   ↓
Clef-Flash  →  probability distribution over your answer options
```

Clef does **not** generate prose. It reads a `state` plus a set of typed questions and returns, in a single forward pass, a probability for every allowed answer — ideal for "what should the agent do next?" decisions.

## Requirements

- macOS (Apple Silicon or x64), Linux (x64/arm64) or Windows x64
- Node.js ≥ 20
- ≥ 16 GB of memory (Clef-Flash 9B @ 4-bit); more headroom enables higher precision

## Quick start

```bash
# 1. Detect hardware, download the model (~6 GB) + llama.cpp runtime, verify checksum + inference
npx clef-mcp install

# 2. Run the MCP server (stdio)
npx clef-mcp
```

`clef-mcp` (step 2) never downloads anything. If the model is missing, tool calls return a structured `MODEL_NOT_INSTALLED` error with a hint.

### Register with your MCP client

**Claude Code**

```bash
claude mcp add clef-mcp -- clef-mcp
# or, without a global install:
claude mcp add clef-mcp -- npx -y clef-mcp
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.clef-mcp]
command = "clef-mcp"
args = []
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "clef-mcp": {
      "command": "clef-mcp",
      "args": []
    }
  }
}
```

**Generic MCP client** — any client that speaks MCP over stdio: run `clef-mcp` as the server command.

Ready-made snippets live in [`examples/`](examples/).

## The `clef_decide` tool

### Input

```json
{
  "state": {
    "task": "Fix failing tests",
    "error": "TypeError: Cannot read properties of undefined",
    "git_diff": "..."
  },
  "questions": {
    "next_action": {
      "type": "choice",
      "instructions": "What should the coding agent do next?",
      "criteria": {
        "inspect": "Inspect the code and gather more information",
        "modify": "Modify the code",
        "test": "Run additional tests",
        "ask_user": "Ask the user for clarification"
      }
    },
    "confidence": {
      "type": "score",
      "instructions": "How confident are you in this decision?",
      "criteria": ["very_low", "low", "medium", "high", "very_high"]
    },
    "is_outage": {
      "type": "noul",
      "instructions": "Is a service down?"
    }
  }
}
```

| Type | Criteria | Meaning |
|------|----------|---------|
| `choice` | map of `option id → description`, or a plain list of options (ids = the strings) | Pick among named options |
| `score` | ordered list of descriptions | Ordered scale (index = score) |
| `noul` | optional `{"true": "...", "false": "..."}` | Yes/no question |

### Output

Strictly structured — the server never turns the result into prose:

```json
{
  "model": "clef-flash",
  "decisions": {
    "next_action": {
      "answer": { "inspect": 0.72, "modify": 0.12, "test": 0.14, "ask_user": 0.02 }
    },
    "confidence": {
      "answer": { "very_low": 0.01, "low": 0.04, "medium": 0.18, "high": 0.61, "very_high": 0.16 }
    },
    "is_outage": {
      "answer": { "true": 0.9, "false": 0.1 }
    }
  }
}
```

`state` is treated strictly as **data**: it is never interpreted as instructions for the MCP server itself (see [Security](#security--data-handling)).

## CLI

```bash
clef-mcp              # run the MCP server on stdio (default command)
clef-mcp install      # detect hardware → download model + runtime → verify checksum → verify inference
clef-mcp models       # list models/quantizations and install status
clef-mcp status       # runtime, model, memory summary
clef-mcp doctor       # full diagnosis (platform, RAM, GPU, binary, model, checksum*, inference, MCP config)
clef-mcp uninstall    # remove the model (and optionally the managed runtime)
clef-mcp evals        # run the evaluation dataset against the installed model
```

Useful flags: `install --quant Q8_0 --yes --skip-probe`, `doctor --deep` (re-hashes the model file), `uninstall --runtime --yes`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CLEF_MODEL` | `clef-flash` | Model id (`clef_decide` also accepts a per-call `model`) |
| `CLEF_HOME` | `~/.cache/clef-mcp` | Cache/model home |
| `CLEF_RUNTIME` | `llama-cpp` | Inference runtime (v0.1: only llama-cpp) |
| `CLEF_LOG_LEVEL` | `error` | `error` \| `warn` \| `info` \| `debug` (logs go to **stderr**) |
| `CLEF_LLAMA_BIN` | – | Explicit path to a `llama-server` binary |
| `CLEF_LLAMA_RELEASE_TAG` | latest nightly | Pin the managed llama.cpp build, e.g. `b11378` |
| `CLEF_MAX_QUESTIONS` | `64` | Max questions per call |
| `CLEF_MAX_STATE_BYTES` | `1048576` | Max serialized `state` size |
| `CLEF_MAX_INSTRUCTION_CHARS` | `10000` | Max chars per question instructions |

Runtime selection order: `CLEF_LLAMA_BIN` → managed binary in `CLEF_HOME/runtime` → `llama-server` on `PATH`.

## Storage layout

```text
~/.cache/clef-mcp/          # or $CLEF_HOME
├── models/
│   └── clef-flash/
│       ├── 4bit/           # Q4_K_M
│       │   ├── Clef-Flash-Q4_K_M.gguf
│       │   └── manifest.json   # repo, revision, sha256, license
│       ├── 8bit/           # Q8_0
│       └── bf16/           # BF16
└── runtime/
    └── llama.cpp/darwin-arm64/llama-server
```

The model is downloaded from the pinned official GGUF conversion ([ggml-org/Clef-Flash-GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF), revision-pinned) and **sha256-verified** against Hugging Face's content hash. It is never repackaged by clef-mcp.

## Error handling

Tool errors are structured JSON with a machine-readable code:

```json
{
  "error": {
    "code": "MODEL_NOT_INSTALLED",
    "message": "Clef model \"clef-flash\" is not installed.",
    "hint": "Run `clef-mcp install`."
  }
}
```

Codes: `MODEL_NOT_INSTALLED`, `MODEL_LOAD_FAILED`, `RUNTIME_NOT_FOUND`, `RUNTIME_INIT_FAILED`, `RUNTIME_NOT_SUPPORTED`, `INVALID_INPUT`, `CLEF_INFERENCE_FAILED`, `UNSUPPORTED_PLATFORM`, `OUT_OF_MEMORY`, `CHECKSUM_MISMATCH`, `DOWNLOAD_FAILED`.

Input exceeding the model's 16k-token context is rejected by the runtime with a hint to reduce the state.

## Architecture

```text
MCP interface (stdio)  →  validation, structured errors
        ↓
Clef adapter  →  clef_decide ⇄ SystemOne wire format (request/response mapping)
        ↓
ClefRuntime (interface)
        ↓
LocalClefRuntime  →  llama.cpp llama-server subprocess
```

The `ClefRuntime` interface (`load / decide / unload / health`) isolates the engine: future MLX or remote runtimes plug in without changing the MCP API.

## Security & data handling

- No network servers, no telemetry, no accounts; everything runs locally.
- The model downloads only on an explicit `install`, over HTTPS, with checksum verification.
- `state` content is passed to the model as data; the server never executes or instruction-interprets it.
- Filesystem access is limited to `CLEF_HOME` (plus reading standard MCP client config paths in `doctor`).
- The managed runtime is the official llama.cpp nightly build; pin it with `CLEF_LLAMA_RELEASE_TAG` if you want reproducibility.

## Development

```bash
npm install
npm run build
npm test          # unit + integration (uses a fake llama-server, no model needed)
npm run evals     # needs an installed model; ~30 cases, exit code reflects pass rate
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [`tests/evals/dataset.jsonl`](tests/evals/dataset.jsonl) for the eval format.

## License

- Code: [Apache-2.0](LICENSE).
- Clef / Clef-Flash model: © Cloudflare, [Apache-2.0](https://huggingface.co/Cloudflare/clef-flash) — see [NOTICE](NOTICE).
- llama.cpp runtime: © its authors, MIT-licensed; downloaded as an official prebuilt binary.
