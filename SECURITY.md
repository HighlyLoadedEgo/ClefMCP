# Security Policy

## Reporting a vulnerability

Please open a private security advisory via GitHub ("Report a vulnerability" on the Security tab) or contact the maintainers directly. Do not open a public issue for exploitable problems.

We aim to acknowledge reports within 7 days.

## Scope and design posture

clef-mcp is a **local-only** tool by design:

- The MCP transport is stdio; no network server is opened.
- No telemetry, analytics or accounts.
- Inference runs in a local llama.cpp subprocess bound to `127.0.0.1` on an ephemeral port.
- The optional daemon uses a local Unix socket created with mode `0600`.
- Classification reads explicit input/profile paths and writes explicit output/checkpoint paths. YAML is data, not executable code. Output uses private files and exclusive writer locks; existing files and source aliases are protected.

## Supply chain

- **Model**: downloaded only via `clef-mcp install`, from the pinned Hugging Face revision (`ggml-org/Clef-Flash-GGUF`), sha256-verified against Hugging Face's content hash (`x-linked-etag`). The manifest in `CLEF_HOME/models/...` records repo/revision/hash/license.
- **Runtime**: official llama.cpp builds (`ggml-org` nightly releases on GitHub), downloaded on explicit install. Pin with `CLEF_LLAMA_RELEASE_TAG`. Bring your own binary via `CLEF_LLAMA_BIN` if you prefer.
- `doctor --deep` re-verifies the model checksum at any time.

## Prompt-injection posture

`state` is arbitrary agent-gathered data (file contents, logs, web pages). clef-mcp treats it strictly as model input data:

- It is never executed, shell-expanded or interpreted as instructions for the server.
- It cannot change server configuration, limits or runtime selection.
- Limits (`CLEF_MAX_STATE_BYTES`, question/criteria caps) bound what can be pushed through.
- Profile examples and record contents remain model input data. Probability, margin and confidence thresholds route uncertain classifications to `needs_review`; they are not an authorization boundary or a guarantee against prompt injection in model judgments.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | yes       |
