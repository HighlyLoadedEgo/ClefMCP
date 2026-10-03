# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
