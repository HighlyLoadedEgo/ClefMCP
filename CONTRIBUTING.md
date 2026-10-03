# Contributing to clef-mcp

Thanks for your interest! This document covers local development.

## Setup

```bash
git clone <your-fork>
cd clef-mcp
npm install
npm run build
npm test
```

- **Build**: `npm run build` (tsup → `dist/`).
- **Tests**: `npm test` builds first, then runs vitest. Unit tests cover validation, the SystemOne adapter, manifests, downloads and the runtime resolver. Integration tests spawn the real CLI over MCP stdio against a fake `llama-server` (`tests/fixtures/fake-llama-server.mjs`) — no model download required.
- **Typecheck only**: `npx tsc --noEmit`.

## Project layout

```text
src/
  cli/      commander commands (serve default, install, models, status, doctor, uninstall, evals)
  mcp/      MCP server, clef_decide tool, zod schemas
  clef/     types, SystemOne adapter, structured errors
  runtime/  ClefRuntime interface, llama.cpp subprocess runtime, binary resolution
  models/   platform detect, quant registry, HF downloader (sha256), manifests, managed runtime
  config/   env config, limits, paths, logger (stderr only)
tests/
  unit/         pure unit tests
  integration/  MCP stdio round-trip + CLI behavior (fake llama-server)
  evals/        evaluation dataset (JSONL) + runner (`clef-mcp evals`)
```

## Rules of the road

- **stdout discipline**: in MCP serve mode, stdout carries the protocol only. All logging must go through the logger (stderr). CLI informational output (install/status/doctor) may use stdout.
- **Structured errors**: user-facing failures go through `ClefError` with a code from `src/clef/errors.ts`. Tool results must stay structured JSON — never render model output as prose.
- **`state` is data**: never interpret state content as instructions for the server.
- **Downloads are explicit**: nothing may auto-download on server start. New artifacts must be pinned (revision/tag) and checksum-verified.
- **Limits**: user-controlled sizes must be bounded in `src/config/limits.ts`, not hardcoded ad hoc.

## Pull requests

1. Fork + branch (`feat/...` or `fix/...`).
2. Add/update tests for behavior changes; keep the full suite green (`npm test`).
3. Update README/docs for user-visible changes.
4. `npx tsc --noEmit` clean.

## Evals

`npm run evals` runs `tests/evals/dataset.jsonl` against the installed model (skips with a clear error if none is installed). Each line:

```json
{
  "id": "unique-id",
  "category": "coding|security|classification|routing|yes_no",
  "state": "…",
  "question": { "id": "qid", "type": "choice", "instructions": "…", "criteria": { "…": "…" } },
  "expected": { "kind": "argmax|prob_gt|min_prob|top_mass", "…": "…" }
}
```

If you change prompting, adapter mapping or runtime, run evals before and after — the pass rate is the regression gate.

## Releasing (maintainers)

1. Update `VERSION` in `src/version.ts` + `package.json`.
2. `npm test && npm run build && npm pack` — smoke-test the tarball.
3. Commit and push the version tag (`git tag v0.1.0 && git push origin v0.1.0`) — the `publish.yml` workflow builds, tests and publishes to npm with provenance. It needs the `NPM_TOKEN` secret in the repo.
