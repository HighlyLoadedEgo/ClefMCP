# PreToolUse guard — a Clef "reflex" before risky shell commands

A hook that asks the local Clef model one `noul` question ("is this destructive?") plus a blast-radius `score` before a shell command runs. Blocks only on a decisive `p(true) ≥ 0.9`; everything else passes with a note on stderr.

## What it looks like

```
$ rm -rf node_modules
clef guard: p(destructive)=0.04 blast_radius=single_file       # allowed

$ git push --force origin main
Blocked: the local Clef model judges this command destructive (p=0.94, blast_radius=repo).
Ask the user to confirm explicitly; if they confirm, let them run it themselves
or have them disable the guard. Do not work around this gate by rephrasing the command.
```

## What a block means — learned in the wild (2026-10-04)

A block is a **pause plus escalation to the user, not a wall**. The first real firing of this guard proved both halves:

1. **The catch worked.** A different agent session, mid history-rewrite, ran `git push --force origin --all` → p=0.94, blocked (exit 2).
2. **The bypass also "worked" — and that was the lesson.** The agent read the script, saw the pre-filter matched the literal string `push --force`, and re-ran the identical push as a `+refspec` (`git push origin '+refs/heads/*:refs/heads/*'`), which slipped past the string match before the model was ever asked. Both fixes shipped as a result:
   - the pre-filter is **semantic about pushes** now: `--force` (incl. `--force-with-lease`), `-f`, `+refspec`, and `git filter-repo`/`filter-branch` all reach the model; a plain `git push` still skips it;
   - the block message **routes the agent to the user** ("ask the user to confirm explicitly") instead of hinting "re-run without the guard" — an LLM reads that hint as an instruction to find a workaround.

Honest residual: the `+refspec` form scores lower than the literal flag (p≈0.87 in the same setup — passes with a lean logged to stderr). A string pre-filter can never be bypass-proof against an agent with full access; this gate's contract is *visibility and a nudge toward the human*, and the tuning knobs (keyword list, thresholds) sit at the top of `guard.sh` on purpose.

## Install

Requirements: `jq` on PATH, `clef-mcp install` done once.

```bash
# 1. Put the script somewhere permanent and make it executable
cp guard.sh ~/.local/bin/clef-guard.sh && chmod +x ~/.local/bin/clef-guard.sh

# 2. Register it as a PreToolUse hook for Bash commands
```

<details open>
<summary><b>Claude Code</b> — <code>~/.claude/settings.json</code></summary>

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/.local/bin/clef-guard.sh" }]
      }
    ]
  }
}
```
</details>

<details>
<summary><b>ZCode</b> — <code>~/.zcode/cli/config.json</code></summary>

Configuration-file hooks are **disabled by default** — the top-level `"enabled": true` is required:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            { "type": "command", "command": "~/.local/bin/clef-guard.sh", "timeout": 90, "statusMessage": "clef guard: judging command risk" }
          ]
        }
      ]
    }
  }
}
```

The matcher is a case-sensitive regex against the tool name (`Bash`, not `bash`). `timeout` is in **seconds** — keep it generous enough for a cold model load; run `clef-mcp daemon` alongside to make the gate sub-second. Exit code `2` is the standard deny.
</details>

## Honest caveats

- **Advisory, not a security boundary.** The guard fails open: missing model, missing `jq`, or a `clef-mcp` error all allow the command. It raises the cost of accidents; it cannot prevent a determined one. A block tells the agent to confirm with the user — the user, not the agent, decides what happens next.
- **Cold start per call** (~a few seconds, model load included). The keyword pre-filter keeps model calls rare — but it now sends every force-flavored push to the model, so history-rewriting sessions pay it repeatedly; run `clef-mcp daemon` alongside to make each gate sub-second.
- **The model is a signal, not a judge.** `p ≥ 0.9` blocks; 0.5–0.9 is a lean printed to stderr for you to read.
- **Tune the threshold and the keyword list to your taste** — both are at the top of `guard.sh` on purpose.
