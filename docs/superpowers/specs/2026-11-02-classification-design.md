# ClefMCP 0.4.0: reusable local classification

Status: approved by the user on 2026-11-02.

## Outcome and scope

Users can define a classification task in YAML, apply it to a JSONL or CSV
dataset, and review uncertain results. One process reuses one loaded local
model across records. Processing can resume after interruption. README and
packaged examples explain the complete workflow. Existing MCP `clef_decide`,
`decide`, runtime configuration and installation behavior remain compatible.

The user requested implementation, testing and publication of 0.4.0, plus an
improved README. The concrete formats and defaults below are proposed choices.

## CLI

```sh
clef-mcp classify tickets.jsonl --profile support-routing.yaml --output results.jsonl
clef-mcp classify tickets.csv --profile support-routing.yaml --output results.jsonl
clef-mcp classify tickets.jsonl --profile support-routing.yaml --output results.jsonl --resume
cat tickets.jsonl | clef-mcp classify - --format jsonl --profile support-routing.yaml
```

`--format jsonl|csv` overrides extension detection. Stdin defaults to JSONL.
Output is always JSONL: a file when `--output` is supplied, otherwise stdout.
Progress and final counts go to stderr. `--model` overrides profile `model`,
then `CLEF_MODEL`, then `clef-flash`. One in-process RuntimeLoader serves
the whole batch, so it does not require a separately started daemon.
Nothing downloads implicitly. No new MCP tool is required for this release.

## YAML profile v1

```yaml
schema_version: 1
name: support-routing
instructions: Classify the current support request into exactly one department.
labels:
  billing: Payments, refunds, invoices and subscription charges
  technical: Errors, outages, installation and integration problems
  other: Requests outside billing and technical support
input:
  id_field: id
  fields: [subject, body]
policy:
  min_probability: 0.80
  min_margin: 0.15
examples:
  - input:
      subject: Duplicate charge
      body: My card was charged twice for one subscription.
    label: billing
```

Required fields: `schema_version: 1`, `name`, nonempty `instructions`, and a
map of 2–100 labels to nonempty descriptions. IDs use letters, digits,
underscores and hyphens, beginning with a letter or digit. `model`, `input`,
`policy` and `examples` are optional. Unknown properties are rejected.

`input.fields` selects exact top-level field names; without it the full record
is used. Missing selected fields produce a row error. `id_field` is copied
to result `id` as a string; without it only the logical row number identifies
the record. IDs must be strings or finite numbers; duplicate IDs are allowed
because checkpointing uses row numbers. If configured, a missing ID is a row
error. CSV cells remain strings, preserving leading zeroes.

Up to 20 labeled examples are allowed. Each label must exist in `labels`.
Examples are supplied as reference data alongside the current record; they
do not fine-tune the model. The combined request obeys existing state and
instruction limits and the runtime's model context limit.

YAML is parsed as data with the YAML 1.2 core schema. Duplicate keys,
multiple documents, aliases, merge keys, unsupported tags and non-JSON
values are rejected. Profile files are bounded to 1 MiB; all new size/count
limits live in `src/config/limits.ts`. Profile validation happens before
loading a model or creating output files.

## Confidence policy and results

Default `min_probability` is 0.80 and `min_margin` is 0.15.
Optional `min_confidence` requires the runtime-reported confidence to pass
that threshold; a missing confidence then requires review. All thresholds
must be finite numbers between 0 and 1. They are policy settings, not a
guarantee that probabilities are calibrated.

One existing `choice` question classifies each record. A valid distribution
must contain exactly the configured labels, finite probabilities in [0, 1],
and a total within 0.001 of 1. Invalid model output is an inference error,
never an accepted classification. Top probability and top-minus-second
margin are compared inclusively to their thresholds. Exact ties always
require review; a stable label ID order breaks ties for display only.

```json
{"row":1,"id":"001","profile":"support-routing","model":"clef-flash","status":"classified","label":"billing","suggested_label":"billing","probability":0.92,"margin":0.87,"probabilities":{"billing":0.92,"technical":0.05,"other":0.03},"review_reasons":[]}
{"row":2,"id":"002","profile":"support-routing","model":"clef-flash","status":"needs_review","label":null,"suggested_label":"technical","probability":0.48,"margin":0.06,"probabilities":{"billing":0.42,"technical":0.48,"other":0.10},"review_reasons":["low_probability","low_margin"]}
```

Results may also include `confidence` and existing token `usage` when
reported. Review reasons are `low_probability`, `low_margin`, `tie`,
`low_confidence`, or `missing_confidence`. Uncertain results retain the
complete distribution and suggestion, while `label: null` prevents consumers
from treating them as accepted. Input content is not copied into output.

## Streaming, errors and output safety

JSONL accepts one JSON object per nonblank line, with UTF-8 BOM and CRLF
support. CSV requires a nonempty unique header row and consistent column
counts; quoted commas, escaped quotes and multiline cells are supported.
Broken CSV syntax is fatal because record boundaries are no longer reliable.
Each logical record is bounded to 1 MiB before selection. Empty input is a
successful zero-record run and does not load the model.

Records are processed sequentially, with bounded buffering and no process
spawn per record. A malformed JSONL record or missing input field writes an
`error` result with row number and the existing structured error code, then
continues. Runtime/model failures stop the batch without marking the current
row completed. Disk errors stop processing immediately. Errors never become
`needs_review` results.

Exit codes: 0 for completion (including review results), 1 for partial row
errors or unexpected failures, 2 for invalid command/profile/input syntax,
3 for a missing model, 4 for a missing runtime, and 130 for interruption.
The stderr summary counts classified, review, error and skipped records.

New output files are created exclusively with private permissions; existing
files are never silently overwritten. Input, profile and output aliases
(including symlinks/hard links) must not permit source truncation. Concurrent
writers to the same output are rejected through an exclusive output lock.
SIGINT/SIGTERM stop taking new records, finish or cancel the current work
safely, close output and dispose only the runtime owned by this command.

## Resume

`--resume` requires a regular input file and `--output`; stdin/stdout resume
is rejected. A private sidecar `<output>.meta.json` records the full input
SHA-256, canonical validated profile SHA-256, effective model, runtime,
input format and result schema version. Metadata is written atomically.
These values must match before an existing result is appended.

Completed JSONL rows must form a valid contiguous prefix with matching
profile/model identity. Resume streams through that prefix and skips it,
including row errors already written. An incomplete final JSONL fragment
from interruption is discarded; corruption in any earlier line is rejected.
Each complete row is committed before proceeding. A crash-stale lock can be
reclaimed only when it belongs to the local host and its process no longer
exists; otherwise the command reports a conflict and preserves files.
Input changes, profile/threshold changes, a different effective model or
runtime, and corrupt/missing metadata require a new output path.
Input must stay unchanged during processing. Hashing and parsing use the
same open input file; file identity, size and modification time are checked
again before successful completion and before appending on resume.

## Implementation boundaries

Small modules under `src/classify/` own profile loading/validation, policy
evaluation, streaming readers, output/checkpoint handling and orchestration.
`src/cli/classify.ts` provides the command handler; `src/cli/index.ts` registers
it. Existing schemas, SystemOne adapter and RuntimeLoader are
reused. New production dependencies: `yaml` 2.9.1 and `csv-parse` 7.0.3,
subject to Node 20/24 compatibility verification before adoption.

## README and examples

Keep README in English, matching the repository. Lead with two clear uses:
MCP decisions for agents and local dataset classification. Add an executable
classification quick start, the profile above, JSONL and CSV samples, exact
result semantics, thresholds, resume restrictions, errors, CLI flags, update
instructions and local-data handling. Separate established measured latency
from new functionality; do not invent classification accuracy claims.
Ship example profile and inputs in the npm package and relevant bundle assets.

## Validation and release

Use red/green tests for profile rejection, policy boundaries/ties/missing
confidence/invalid distributions, JSONL/CSV edge cases, field selection,
runtime reuse, error rows, interruption, output conflicts, resume recovery
and mismatch rejection. Exercise the CLI with the existing
fake runtime. Verify a fresh tarball install and run README examples against
the installed real model, covering accepted and review results.

Run all existing tests and typechecking, Linux/macOS CI on Node 20/24, and
compare the existing eval dataset before/after if shared prompting or adapter
behavior changes. Sync every version file, document 0.4.0 in CHANGELOG,
publish npm with provenance, wait for public visibility before MCP Registry,
attach the .mcpb artifact and verify all public deliverables. The 0.3.1
propagation failure must not be repeated without a visibility wait/retry.
