#!/usr/bin/env bash
# PreToolUse guard: ask the local Clef model whether a shell command looks
# destructive before it runs. Blocks (exit 2) only on a decisive p(true).
#
# Contract (Claude Code / ZCode PreToolUse):
#   stdin  : event JSON, command at .tool_input.command
#   exit 0 : allow
#   exit 2 : block (stderr is shown to the agent)
#
# Design notes:
#   - Fail open. If the model or jq is missing, the guard allows the command:
#     it is an advisory gate, not a security boundary.
#   - Cold start. Each decide call loads the model (~a few seconds). The cheap
#     keyword pre-filter keeps the model calls rare.
#   - Threshold. Blocking requires p(destructive) >= 0.9; below that the
#     command runs and the lean is logged to stderr.

set -euo pipefail

EVENT=$(cat)
COMMAND=$(printf '%s' "$EVENT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

# Cheap pre-filter: only spend a model call on plausibly risky commands.
# History-rewriting pushes come in several clothes: --force, -f, force-with-lease
# and the +refspec form ('git push origin "+refs/heads/*:refs/heads/*"') — all
# go to the model, because a literal 'push --force' match alone was bypassed in
# the wild (2026-10-04: same push re-run as a +refspec).
if ! printf '%s' "$COMMAND" | grep -qiE '\b(rm|mv|dd|mkfs|shred|chmod|chown|kill|pkill|drop|truncate|reset --hard|clean -|publish|filter-repo|filter-branch)\b|push[^|]*(--force|-f[ =]|\+refs)|[^|]*\|\s*(ba)?sh'; then
  exit 0
fi

DECISION=$(printf '%s' "$EVENT" | jq -n \
  --arg cmd "$COMMAND" \
  '{
    state: { source: "pretooluse-guard", command: $cmd },
    questions: {
      is_destructive: {
        type: "noul",
        instructions: "Could this shell command irreversibly destroy data, credentials or published state (deletion, force-push, credential exposure, publishing)?"
      },
      blast_radius: {
        type: "score",
        instructions: "How much damage could this command cause if it is a mistake?",
        criteria: ["none", "single_file", "repo", "machine", "beyond_machine"]
      }
    }
  }' | clef-mcp decide) || {
  echo "clef guard unavailable; allowing command" >&2
  exit 0
}

P_DESTRUCTIVE=$(printf '%s' "$DECISION" | jq -r '.decisions.is_destructive.answer.true')
TOP_RADIUS=$(printf '%s' "$DECISION" | jq -r '.decisions.blast_radius.answer | to_entries | max_by(.value) | .key')

echo "clef guard: p(destructive)=$P_DESTRUCTIVE blast_radius=$TOP_RADIUS" >&2

BLOCKED=$(printf '%s' "$DECISION" | jq -n --argjson p "$P_DESTRUCTIVE" '$p >= 0.9')
if [ "$BLOCKED" = "true" ]; then
  echo "Blocked: the local Clef model judges this command destructive (p=$P_DESTRUCTIVE, blast_radius=$TOP_RADIUS). Ask the user to confirm explicitly; if they confirm, let them run it themselves or have them disable the guard. Do not work around this gate by rephrasing the command." >&2
  exit 2
fi

exit 0
