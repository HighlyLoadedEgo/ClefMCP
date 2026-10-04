# CI triage — label a pull request with the local Clef model

A GitHub Actions job that runs `clef-mcp decide` on the PR diff and reports severity + area. The result lands in the step summary and as job outputs; wiring it to GitHub labels is one `gh` call you can uncomment.

> **Runner reality check:** `ubuntu-latest` (16 GB RAM) fits the Q4_K_M model (6 GB), but inference is CPU-only and the one-time `install` downloads ~6 GB + the llama.cpp build. Expect ~1–3 min of setup per job. For anything hotter than a few PRs per hour, use a self-hosted runner with the model pre-installed and drop the `install` step.

```yaml
# .github/workflows/clef-triage.yml
name: clef-triage

on:
  pull_request:

jobs:
  triage:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      severity: ${{ steps.decide.outputs.severity }}
      area: ${{ steps.decide.outputs.area }}
    steps:
      - uses: actions/checkout@v4

      - name: Install model + runtime (one-time ~6 GB, CPU inference)
        run: npx -y clef-mcp@latest install --yes

      - name: Collect the diff as state
        run: gh pr diff ${{ github.event.pull_request.number }} > /tmp/pr.diff
        env:
          GH_TOKEN: ${{ github.token }}

      - name: Decide
        id: decide
        run: |
          DIFF=$(jq -Rs . < /tmp/pr.diff)
          RESULT=$(jq -n --argjson diff "$DIFF" '{
            state: { pr: ${{ toJSON(github.event.pull_request.title) }}, diff: $diff },
            questions: {
              severity: { type: "score", instructions: "How severe are the changes in this diff if they ship as-is?",
                          criteria: ["trivial", "minor", "moderate", "major", "critical"] },
              area: { type: "choice", instructions: "Which area does this diff primarily touch?",
                      criteria: { frontend: "UI / client code", backend: "server / API code", infra: "CI, build, deployment", docs: "documentation only" } }
            }
          }' | npx -y clef-mcp@latest decide)

          SEVERITY=$(jq -r '.decisions.severity.answer | to_entries | max_by(.value) | .key' <<<"$RESULT")
          AREA=$(jq -r '.decisions.area.answer | to_entries | max_by(.value) | .key' <<<"$RESULT")
          echo "severity=$SEVERITY" >> "$GITHUB_OUTPUT"
          echo "area=$AREA" >> "$GITHUB_OUTPUT"
          echo "| question | pick |" >> "$GITHUB_STEP_SUMMARY"
          echo "|---|---|" >> "$GITHUB_STEP_SUMMARY"
          echo "| severity | $SEVERITY |" >> "$GITHUB_STEP_SUMMARY"
          echo "| area | $AREA |" >> "$GITHUB_STEP_SUMMARY"

      # Optional: apply the verdict as labels (needs contents:write / pull-requests: write).
      # - name: Label
      #   run: gh pr edit ${{ github.event.pull_request.number }} --add-label "triage-${{ steps.decide.outputs.severity }}"
      #   env:
      #     GH_TOKEN: ${{ github.token }}
```

## Honest caveats

- **The 9B model triages; it does not review.** Use the verdict for routing and prioritization, not as a merge gate.
- **Diff size:** the model context is 16k tokens; a huge diff degrades both latency and judgment. Truncate `/tmp/pr.diff` (e.g. `head -c 50000`) for large PRs.
- **Cold start per job.** The `install` step re-downloads unless you cache `~/.cache/clef-mcp` with `actions/cache` keyed on the model revision — or move to a self-hosted runner.
- **State is data.** The diff is passed to the model as content to judge, never as instructions; the server treats it that way (see SECURITY.md).
