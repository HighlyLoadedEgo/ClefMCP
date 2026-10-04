# clef-mcp automation recipes

One-shot `clef-mcp decide` recipes — callers that invoke the decision model **deterministically** (hooks, CI), where the call happens because the infrastructure says so, not because an LLM chose to.

| Recipe | What it does |
|---|---|
| [`pretooluse-guard/`](pretooluse-guard/) | PreToolUse hook: block shell commands the model judges destructive (p ≥ 0.9), note softer leans on stderr |
| [`ci-triage/`](ci-triage/) | GitHub Action: severity + area verdict for a PR diff, into the step summary / labels |

Both recipes are honest about the trade-offs: cold start per `decide` call (~seconds, model load included), advisory-only gating (fail open), and a 16k-token context ceiling for state. Read the caveats in each folder before wiring them into real workflows.

Client registration snippets (MCP config for Claude Code / Codex / Cursor) live in the sibling folders: [`../claude-code/`](../claude-code/), [`../codex/`](../codex/), [`../cursor/`](../cursor/).
