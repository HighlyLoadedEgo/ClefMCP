# PreToolUse guard — a Clef "reflex" before risky shell commands

A hook that asks the local Clef model one `noul` question ("is this destructive?") plus a blast-radius `score` before a shell command runs. Blocks only on a decisive `p(true) ≥ 0.9`; everything else passes with a note on stderr.

## What it looks like

```
$ rm -rf node_modules
clef guard: p(destructive)=0.04 blast_radius=single_file       # allowed

$ git push --force origin main
Blocked: the local Clef model judges this command destructive (p=0.97, blast_radius=beyond_machine).
```

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

- **Advisory, not a security boundary.** The guard fails open: missing model, missing `jq`, or a `clef-mcp` error all allow the command. It raises the cost of accidents; it cannot prevent a determined one.
- **Cold start per call** (~a few seconds, model load included). The keyword pre-filter keeps model calls rare; do not use this pattern for hot per-call gates without a warm daemon.
- **The model is a signal, not a judge.** `p ≥ 0.9` blocks; a 0.7 is a lean printed to stderr for you to read.
- **Tune the threshold and the keyword list to your taste** — both are at the top of `guard.sh` on purpose.
