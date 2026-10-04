# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- `clef_decide` tool description tightened after a TDQS re-evaluation dropped conciseness to 4/5: the temperature no-op is now stated only in the schema (was duplicated in prose), and the confidence/usage + threshold guidance is compressed to two lines.
- PreToolUse guard recipe, hardened after its first real firing (2026-10-04):
  - the pre-filter is semantic about history-rewriting pushes — `--force` (incl. `--force-with-lease`), `-f`, the `+refspec` form, and `git filter-repo`/`filter-branch` all reach the model; previously a literal `push --force` match alone was bypassed by re-running the same push as a `+refspec`;
  - the block message now routes the agent to the user ("ask the user to confirm explicitly") instead of hinting at a re-run without the guard;
  - recipe README documents the block semantics (pause + escalation, not a wall) and the incident.

## [0.3.0] — 2026-10-04

### Added
- **`clef-mcp decide`** — one-shot decision CLI for hooks, CI and scripts: reads `{state, questions, model?}` from stdin or `--questions`/`--state` files (inline values accepted), validates with the same schema and limits as the MCP tool, prints strict JSON to stdout; errors structured on stderr with exit codes (2 invalid input, 3 model not installed, 4 runtime missing). Never downloads anything.
- **`clef-mcp daemon`** — keeps the model warm on a permission-scoped unix socket in `CLEF_HOME` (no TCP port); `clef-mcp decide --daemon` answers in well under a second and falls back to a cold run when no daemon is reachable. Model unloads after `CLEF_DAEMON_IDLE` seconds (default 600, `0` = never).
- **Model confidence + token usage in results**: every decision now carries the model-reported `confidence` (when the runtime sends it) and the response carries `usage` (`input_tokens`/`output_tokens`/`latency_ms`, with `prompt_tokens`/`completion_tokens` aliases canonicalized) — both in the MCP tool result and the CLI output, so the "act only when p ≥ 0.8" rule is checkable.
- **Automation recipes** in `examples/hooks/`: a PreToolUse guard that blocks shell commands the model judges destructive (p ≥ 0.9, fails open), and a GitHub Action that triages PR diffs into severity/area.

### Changed
- Runtime resolution (manifest → binary → runtime, lazy load, factory test seam) extracted from the MCP server into a shared `RuntimeLoader`; server, `decide` and `daemon` exercise the identical chain.
- `clef-decisions` skill: new "When NOT to call it" section (skip when the answer is known, when the task needs generation/reasoning, when re-asking without new facts), confidence-based thresholds, state-size vs latency guidance.
- Tool description documents the new `confidence`/`usage` fields and the decisive-argmax rule.

## [0.2.0] — 2026-10-03

### Added
- **MCP prompts** (4): `incident-triage`, `next-action`, `ticket-routing`, `security-review` — canned decision-shaped asks that frame `clef_decide` calls, including safety thresholds for security-adjacent decisions.
- **MCP resources** (3): `clef-mcp://capabilities` (live capability snapshot), `clef-mcp://evals/schema`, `clef-mcp://evals/dataset`.
- **MLX runtime** (macOS / Apple Silicon): `MlxRuntime` behind the existing `ClefRuntime` interface, running the bundled `clef_mlx.py serve` from a pinned `mlx-community/clef-flash-4bit` snapshot inside a uv-managed environment. `clef-mcp install --runtime mlx`, `CLEF_RUNTIME=mlx`, `CLEF_MLX_UV` override; uninstall/status/doctor/evals aware.
- `.mcpb` bundle attached to every GitHub Release (installable directly in Claude Desktop and accepted by MCP directories).

### Changed
- `CLEF_RUNTIME` now accepts `llama-cpp | mlx`; llama.cpp stays the default.

## [0.1.5] — 2026-10-03

### Fixed
- llama.cpp physical batch raised to 8192 (`-b`/`-ub`): multi-question requests with 5+ questions were rejected by the default 512-token ubatch ("input too large"). Override with `CLEF_LLAMA_BATCH`; batch-size errors now return an actionable hint.

## [0.1.4] — 2026-10-03

### Added
- `clef-mcp setup` — registers the MCP server and the agent skill in your clients: ZCode (`~/.zcode/cli/config.json`), Claude Code (`claude mcp add --scope user`), Codex (`~/.codex/config.toml`), Cursor (`~/.cursor/mcp.json`), plus the `clef-decisions` skill in `~/.agents/skills/`. Idempotent; `--clients` and `--no-skill` flags.
- `clef-mcp install --setup` — chains client registration right after the model install.

## [0.1.3] — 2026-10-03

### Added
- Bundled agent skill `clef-decisions` (ships in the npm package): when/how to call `clef_decide`, batching, criteria writing, distribution interpretation, error recovery.
- README: ZCode client configuration, skill install instructions.

## [0.1.2] — 2026-10-03

### Changed
- `choice` questions accept criteria as a plain list (`string[]`) in addition to the map form, mirroring the spec; the adapter converts lists to the SystemOne map shape.

## [0.1.1] — 2026-10-03

### Changed
- npm publishing moved to Trusted Publishing (OIDC) — no tokens in CI.

## [0.1.0] — 2026-10-03

### Added
- Initial release: local MCP server exposing the Cloudflare **Clef-Flash** decision model through a single structured tool, `clef_decide`.
  - Question types: `choice` (probability per option), `score` (ordered scale), `noul` (yes/no). Up to 64 questions per call, one forward pass.
  - `clef-mcp install`: hardware detection, quantization pick (Q4_K_M / Q8_0 / BF16), pinned Hugging Face download with sha256 verification, managed llama.cpp runtime, inference probe.
  - `clef-mcp models | status | doctor | uninstall | evals`.
  - llama.cpp runtime abstraction (`ClefRuntime`), SystemOne wire adapter, structured error codes, stderr-only logging.
  - Evaluation dataset (30 cases) and runner; 26/30 (86.7%) on the live Q4_K_M model.
  - Client examples for Codex, Claude Code, Cursor; docs (CONTRIBUTING, SECURITY, Code of Conduct, NOTICE).
