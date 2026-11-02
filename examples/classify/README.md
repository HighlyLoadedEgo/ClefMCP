# Classify support requests locally

These files ship with the npm package. After `clef-mcp install`, run from this directory:

```sh
clef-mcp classify tickets.jsonl --profile support-routing.yaml --output results.jsonl
clef-mcp classify tickets.csv --profile support-routing.yaml --output csv-results.jsonl
clef-mcp classify tickets.jsonl --profile support-routing.yaml --output results.jsonl --resume
```

Both inputs contain the same three records. CSV IDs stay strings (`001`).
The third request deliberately overlaps billing and technical support; its
result depends on the model distribution and the profile policy.

Results are JSONL. `classified` has an accepted `label`; `needs_review` has
`label: null`, a `suggested_label`, probabilities and review reasons. There is
no fixed expected answer/accuracy claim for this example.

To inspect stricter review behavior, copy the profile and set
`min_probability: 1.0`. To accept more results, lower the thresholds only
after checking the distributions on representative labeled data. A threshold
does not establish calibrated accuracy or replace authorization checks.

Output paths must be new, or use `--resume` with the same input/profile/model/runtime.
Changing a threshold requires a new output path. Resume skips every committed
row, including error rows; it does not retry failed input records. See the main
README for sidecars, locks, exit codes and input limits.
