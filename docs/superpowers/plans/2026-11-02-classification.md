# ClefMCP 0.4.0 Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish YAML-profile classification of JSONL/CSV datasets with explicit review results, safe resume, and complete README examples.

**Architecture:** A CLI handler composes a validated single-choice profile, a streaming input source, a durable JSONL output session and one lazy RuntimeLoader. Pure policy evaluation decides classified versus needs_review; row errors remain separate from inference failures. Existing MCP and decide contracts remain unchanged.

**Tech Stack:** TypeScript ESM, Node >=20, existing Zod/runtime/SystemOne adapter, yaml 2.9.1, csv-parse 7.0.3, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-classification-design.md` (approved by user in chat on 2026-11-02).

## Global Constraints

- Preserve existing MCP, decide, installation, runtime and stdout behavior.
- YAML schema_version 1; 2–100 labels; up to 20 examples; profile and logical record limits 1 MiB.
- Defaults: min_probability 0.80, min_margin 0.15; optional min_confidence; every exact tie needs review.
- Stream records sequentially with bounded buffering; load the model at most once per batch.
- Never download implicitly, execute YAML, silently overwrite output, accept invalid distributions, or call an error needs_review.
- Input JSONL/CSV; output JSONL; input CSV cells stay strings. All new operational limits belong to src/config/limits.ts.
- Resume requires a regular input file plus output path and matching input/profile/model/runtime/format/schema fingerprints.
- Tests first for behavior, full npm test before release, fresh tarball and real-model smoke, Linux/macOS Node20/24 CI.
- README remains English and documents executable examples and limits without inventing measured accuracy.
- The user already authorized implementation and publication; do not ask for publication permission again.

## Review Focus

1. CSV quoted multiline fields and duplicate/blank headers: preserve valid cells and reject ambiguous structure (Task 2 tests).
2. YAML duplicate keys, aliases, unsupported tags, prototype-shaped keys and nonfinite values: reject instead of coercing or executing (Task 1 tests).
3. Restart after a partial last write versus corruption in earlier output: recover only an incomplete tail and preserve other files (Task 3 tests).
4. Input/profile/output aliases, live/stale locks and concurrent writers: preserve sources and refuse unsafe append (Task 3 tests).
5. Changed input during hashing/inference, missing confidence, invalid distributions and interrupted runtime ownership: reject inconsistent output and dispose only this command's model (Tasks 1, 2, 4 tests).

## File ownership and interfaces

- `src/classify/profile.ts`: exported `ClassificationProfile`, `parseProfile(text, limits)`, `loadProfile(path, limits)`, `selectRecord(profile, record)`, `profileState(profile, record)` and `profileDigest(profile)`.
- `src/classify/policy.ts`: exported `evaluateClassification(profile, decision)` returning accepted/review policy fields.
- `src/classify/input.ts`: exported `openInput(path, format, limits)` returning InputSource with `format`, optional `fingerprint`, `records()`, `verifyUnchanged()`, `close()`.
- `src/classify/output.ts`: exported result/metadata types and `openOutput(options)` returning `completedRows`, `append(result)`, `finish(totalRows)`, `close()`.
- `src/cli/classify.ts`: exported `ClassifyOptions` and `runClassify(inputPath, options): Promise<number>`; owns RuntimeLoader, orchestration, summary and signals.
- `src/config/limits.ts`: `CLASSIFY_LIMITS` with fixed profile/record/example/checkpoint bounds, without changing existing `Limits` consumers.
- `src/cli/index.ts`: register classify and propagate its exit code.
- `examples/classify/`: packaged profile plus matching JSONL/CSV inputs.

InputRow is `{row: number, record?: Record<string, unknown>, error?: StructuredError['error']}`.
InputSource records are logical rows after blank-line/header removal, numbered from 1.
Metadata contains `{schema_version:1,input_sha256,profile_sha256,model,runtime,format}`.
Base result fields are `{row,id?,profile,model,status}`. Classified/review variants add
`label`, `suggested_label`, `probability`, `margin`, `probabilities`, `review_reasons`,
optional `confidence` and `usage`; error variants add `error` and `label:null`.

---

### Task 1: Validate profiles and evaluate uncertainty

**Files:** create src/classify/profile.ts, src/classify/policy.ts, tests/unit/classify-profile.test.ts, tests/unit/classify-policy.test.ts; modify src/config/limits.ts, package.json, package-lock.json.

**Consumes:** existing Limits, ClefError and ClefDecisionAnswer; approved YAML format.
**Produces:** ClassificationProfile and pure profile/policy functions named above.

- [ ] Write profile tests before product code. Cover valid defaults, optional fields/examples/model, strict unknown fields, invalid versions/thresholds, fewer than two labels, example labels absent from criteria, duplicate YAML keys, aliases, custom tags, dangerous map keys and oversized text. Missing selected fields and malformed IDs must return INVALID_INPUT.

```ts
it('rejects duplicate YAML labels', () => {
  const text = 'schema_version: 1\nname: routing\ninstructions: Route it\nlabels:\n  billing: Payments\n  billing: Again\n  other: Other\n';
  expect(() => parseProfile(text, DEFAULT_LIMITS)).toThrow(/duplicate|unique/i);
});
```

- [ ] Write policy boundary tests with hand-derived distributions. At `{a:0.8,b:0.2}` and min_margin 0.15 accept a; `{a:0.5,b:0.5}` must return label null and tie even when both thresholds are 0. Missing required confidence must require review. Reject missing/extra labels, negative/out-of-range/nonfinite probabilities and totals outside tolerance.

```ts
it('keeps an uncertain suggestion separate from an accepted label', () => {
  const result = evaluateClassification(profile, { answer: { billing: 0.55, other: 0.45 } });
  expect(result.status).toBe('needs_review');
  expect(result.label).toBeNull();
  expect(result.suggested_label).toBe('billing');
  expect(result.review_reasons).toEqual(['low_probability', 'low_margin']);
});
```

- [ ] Run `npx vitest run tests/unit/classify-profile.test.ts tests/unit/classify-policy.test.ts`.
Expected: the new feature is missing; after initial exports exist, expectations fail on absent validation/policy behavior.
- [ ] Install exact production dependency versions with `npm install --save-exact yaml@2.9.1 csv-parse@7.0.3`.
- [ ] Implement profile parsing with parseDocument YAML1.2/core, strict unique keys, string keys, no known/custom tags, no aliases (`toJS({maxAliasCount:0})`), rejection of warnings/errors, and strict Zod validation. Reject prototype-shaped reserved map IDs rather than assigning unsafe properties. Bound profile reading before buffering. Reuse existing question and state validation when building a request.
- [ ] Implement policy using validated exact-label distributions and inclusive comparisons with a small numeric tolerance. Preserve the original distribution and optional confidence. Central decision logic:

```ts
const ranked = Object.entries(decision.answer).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const [top, second] = [ranked[0]!, ranked[1]!];
const margin = top[1] - second[1];
const reasons: string[] = [];
if (top[1] < profile.policy.min_probability - 1e-12) reasons.push('low_probability');
if (margin < profile.policy.min_margin - 1e-12) reasons.push('low_margin');
if (top[1] === second[1]) reasons.push('tie');
```

- [ ] Run the focused command, then `npm test`.
Expected: all profile/policy tests and existing tests pass, including TypeScript.
- [ ] Commit: `git commit -m 'feat: add YAML classification profiles and policy'`.

### Task 2: Stream JSONL and CSV input safely

**Files:** create src/classify/input.ts and tests/unit/classify-input.test.ts.
**Consumes:** CLASSIFY_LIMITS and existing structured errors; no model dependencies.
**Produces:** InputSource and InputRow interfaces described above.

- [ ] Write tests covering UTF-8 split across chunks, BOM/CRLF, blank lines, JSON object validation, invalid JSONL row continuation, record limits, empty input, stdin, CSV leading-zero IDs, multiline quoted fields, commas, escaped quotes, duplicate/blank headers, mismatched counts and unclosed quotes.

```ts
it('preserves multiline CSV cells and leading-zero IDs', async () => {
  await writeFile(inputPath, 'id,body\r\n001,"first line\nsecond, line"\r\n');
  const source = await openInput(inputPath, undefined, DEFAULT_LIMITS);
  try {
    const rows = [];
    for await (const row of source.records()) rows.push(row);
    expect(rows).toEqual([{ row: 1, record: { id: '001', body: 'first line\nsecond, line' } }]);
  } finally { await source.close(); }
});
```

- [ ] Run `npx vitest run tests/unit/classify-input.test.ts`.
Expected: missing reader or behavior assertions fail.
- [ ] Implement a bounded streaming JSONL decoder and csv-parse async iterator with strict columns, explicit UTF-8, BOM support, no casting, max_record_size, skip_empty_lines and header validation. Invalid JSONL becomes an InputRow error; structural CSV errors throw INVALID_INPUT. Bound buffering before allocation grows beyond record limits; never split quoted CSV by physical line.
- [ ] Open regular input once, hash through that handle, rewind through a new stream sharing the same handle, and retain inode/device/size/mtime identity. Stdin has no fingerprint and is never closed by ownership cleanup. Check both the open handle and path identity for modifications.

```ts
const initial = await handle.stat();
// After hashing and before reporting completion:
const current = await handle.stat();
if (current.dev !== initial.dev || current.ino !== initial.ino ||
    current.size !== initial.size || current.mtimeMs !== initial.mtimeMs) {
  throw new ClefError(ClefErrorCode.INVALID_INPUT, 'Input changed during classification');
}
```

- [ ] Add a test that rewrites/replaces the input between records; verifyUnchanged must reject. Verify reader cleanup on parser errors.
- [ ] Run focused tests, then `npm test`.
Expected: all tests pass and input memory is bounded by the configured record size.
- [ ] Commit: `git commit -m 'feat: stream JSONL and CSV classification input'`.

### Task 3: Write durable results and resume matching runs

**Files:** create src/classify/output.ts and tests/unit/classify-output.test.ts.
**Consumes:** InputSource fingerprint/format, profileDigest, effective model/runtime and result types.
**Produces:** output session with completedRows, append, finish and close.

- [ ] Write tests for exclusive creation, mode0600, stdout backpressure, matching resume, input/profile/model/runtime/format mismatch, missing metadata, invalid row sequence and result identity, existing paths/symlinks/hardlinks, input/profile/output alias protection, live lock rejection, crash-stale lock handling, write failures and an interrupted last JSONL fragment.

```ts
it('recovers only a partial final output record', async () => {
  await writeFile(outputPath, JSON.stringify(validRow1) + '\n{"row":2');
  await writeFile(outputPath + '.meta.json', JSON.stringify(metadata));
  const out = await openOutput({ path: outputPath, resume: true, metadata, protectedPaths });
  try {
    expect(out.completedRows).toBe(1);
    await out.append(validRow2);
  } finally { await out.close(); }
  expect((await readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse)).toEqual([validRow1, validRow2]);
});
```

- [ ] Run `npx vitest run tests/unit/classify-output.test.ts`.
Expected: missing output session or recovery assertions fail.
- [ ] Implement exclusive output and lock creation, private modes, atomic sidecar write and exact metadata comparison. Refuse replacing sources and nonregular resume files. Stream existing results with bounded line size, verify contiguous row numbers and result schema; truncate only a non-newline-terminated final fragment after validating the prefix. Never discard a complete but invalid final JSON line.
- [ ] Commit a result before taking the next input row:

```ts
await outputHandle.writeFile(JSON.stringify(result) + '\n', 'utf8');
await outputHandle.sync();
completedRows = result.row;
```

- [ ] Release only locks owned by this session; reclaim only demonstrably dead local locks after revalidation. Close all owned handles on every failure path. finish(totalRows) rejects a checkpoint longer than its input.
- [ ] Run focused tests, then `npm test`.
Expected: valid resume appends exactly one result per remaining logical row; unsafe inputs preserve existing files.
- [ ] Commit: `git commit -m 'feat: checkpoint classification results for resume'`.

### Task 4: Compose the classify CLI and reuse the runtime

**Files:** create src/cli/classify.ts and tests/integration/classify-cli.test.ts; modify src/cli/index.ts and test fixtures/helpers only as needed.
**Consumes:** Task1 profile/policy, Task2 input, Task3 output, existing RuntimeLoader/SystemOne adapter.
**Produces:** usable classify command and final exit codes.

- [ ] Write CLI tests for unknown command before registration, then profile/default behavior, JSONL/CSV/stdi/o, explicit format, CLI/profile/env model precedence, accepted/review/error rows, exit codes, output cleanliness, summary counts, unchanged empty-input behavior, resume skip, interruption and one actual fake runtime start per batch (existing FAKE_LLAMA_START_LOG).

```ts
const run = await runCli(['classify', inputPath, '--profile', profilePath], install.env);
expect(run.code).toBe(0);
const rows = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
expect(rows).toHaveLength(2);
expect(rows[0].status).toBe('needs_review'); // fake choice top p is 0.6
expect(rows[0].label).toBeNull();
expect(rows[0].suggested_label).toBe('billing');
expect(run.stderr).toContain('needs_review');
```

- [ ] Run `npm run build && npx vitest run tests/integration/classify-cli.test.ts`.
Expected: unknown classify command or missing behavior causes the new tests to fail.
- [ ] Register command with positional input, required --profile and optional --output, --format, --model, --resume. Validate options/profile/model and resume eligibility before output/inference. Open the input, compute metadata, open the output and iterate sequentially. Skip existing committed rows without inference. Select fields, add examples as reference data and ask one choice question named classification.

```ts
const input = { model, state: profileState(profile, selected), questions: {
  classification: { type: 'choice' as const, instructions: profile.instructions, criteria: profile.labels },
} };
validateStateSize(input.state, config.limits);
const { runtime } = await loader.ensure(spec);
const response = await runtime.decide(toSystemOneRequest(input, model));
const decision = fromSystemOneResponse(response, input.questions, model).decisions.classification!;
const result = evaluateClassification(profile, decision);
```

- [ ] Handle malformed row/selection errors as error records; stop immediately on inference/system/model/IO failures without completing the current row. Produce summary on stderr and 0/1/2/3/4/130 exit codes per spec. Signal handling stops new work and disposes this command's loader, output and input in finally blocks, without touching a separate daemon.
- [ ] Test real adapter responses via the fake HTTP runtime, including invalid returned label distributions and confidence requirements. A valid row after an invalid JSONL row must still run. Empty input must succeed without a model installed.
- [ ] Run `npm test`.
Expected: entire suite green; multiple input rows cause one runtime process start; resumed runs produce no duplicate rows.
- [ ] Commit: `git commit -m 'feat: classify datasets with explicit review results'`.

### Task 5: Ship examples, improve README and release 0.4.0

**Files:** modify README.md, CHANGELOG.md, CONTRIBUTING.md, version manifests, package.json/package-lock.json, .github/workflows/publish.yml; create examples/classify/support-routing.yaml, tickets.jsonl, tickets.csv and README.md.
**Consumes:** working CLI and approved result semantics; existing release workflow.
**Produces:** packaged user documentation and verified public update.

- [ ] Add the approved profile and matching three-record JSONL/CSV examples; demonstrate classified and needs_review through explicit profiles with different policy thresholds. Keep examples independent of hidden repository files.
- [ ] Rewrite README opening/quickstart around MCP decisions and dataset classification. Include all profile fields, field selection, labeled examples, probability/margin/confidence distinction, output examples, review reasons, error/exit semantics, stdout/stderr, format detection, resume fingerprint/lock restrictions and updating/restarting existing clients. Retain accurate existing runtime/MCP guidance and measured numbers.
- [ ] Add an npm visibility wait before MCP Registry publication, using the exact version and public registry, with bounded retries:

```sh
for attempt in $(seq 1 20); do
  FOUND=$(npm view "clef-mcp@$VERSION" version --registry=https://registry.npmjs.org --prefer-online 2>/dev/null || true)
  if [ "$FOUND" = "$VERSION" ]; then break; fi
  if [ "$attempt" = 20 ]; then echo "npm version is not publicly visible" >&2; exit 1; fi
  sleep 30
done
```

- [ ] Sync package.json, package-lock.json root/package version, src/version.ts, server.json and manifest.json to0.4.0. Add precise release notes and scope without accuracy claims.
- [ ] Run `npm test` and `git diff --check`, pack into the chat work directory and install that tarball in a clean temporary prefix. Check --version, --help, packaged examples and execute README JSONL/CSV/resume examples with fake and real installed Clef-Flash. Force a review result with min_probability1, and verify a decisive real-model result using a clearly separable task.
Expected: tests/typecheck pass, package reports0.4.0, examples run and output schema is correct. No new model download occurs.
- [ ] Obtain a fresh whole-branch code review, fix important findings through red/green tests, rerun npm test, and commit all release changes.
- [ ] Fast-forward main only after checking the remote has not diverged; push the approved changes, wait for Linux/macOS Node20/24 CI, tag v0.4.0 and push the tag. If the remote moves, fetch and reconcile without force-pushing or dropping other changes.
- [ ] Verify npm latest and install version0.4.0 from the public registry into a clean prefix. Check MCP Registry publication, GitHub Release and nonempty clef-mcp-0.4.0.mcpb asset. Use release notes from CHANGELOG and report exact publication status.
Expected: every public deliverable is available and the source tree is clean. Retry only failed publication jobs when propagation delays occur; npm publication is idempotently skipped when already present.

## Self-review

All approved spec sections are owned by Tasks1–5. Shared interfaces use the
names in the file/interface section. Review Focus cases have explicit tests
in their owning tasks. No changes to existing shared prompting or runtime
semantics are planned; existing evals become required if that changes.

Status: proposed implementation plan, awaiting review and execution-method selection.
