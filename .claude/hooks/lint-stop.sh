#!/usr/bin/env bash
# Drain the queue from lint-post-edit.sh and run oxlint once over it, emitting
# {decision:"block"} so Claude self-corrects before the turn ends.
#
# Loop guard: `stop_hook_active` means a previous Stop hook already blocked —
# drain and exit, or unfixable issues trap Claude in a re-block loop.

set -u

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false')

if [ -z "$session_id" ]; then exit 0; fi

queue="${TMPDIR:-/tmp}/claude-lint-queue-${session_id}.list"
if [ ! -f "$queue" ]; then exit 0; fi

# Always drain the queue, even on early exit / error.
trap 'rm -f "$queue"' EXIT

if [ "$stop_hook_active" = "true" ]; then exit 0; fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || true

if [ ! -x node_modules/.bin/oxlint ]; then exit 0; fi

# Dedupe, then keep files that still exist AND belong to this repo. A sibling
# checkout has its own config and its own gate; linting it with this repo's
# config reports against rules it never opted into.
project=$(pwd -P)
files=$(sort -u "$queue" | while IFS= read -r f; do
  if [ ! -f "$f" ]; then continue; fi
  abs=$(cd "$(dirname "$f")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$f")") || continue
  case "$abs" in "$project"/*) printf '%s\n' "$abs" ;; esac
done)

if [ -z "$files" ]; then exit 0; fi

out=$(printf '%s\n' "$files" | xargs node_modules/.bin/oxlint --deny-warnings --no-error-on-unmatched-pattern 2>&1)
code=$?

if [ $code -ne 0 ]; then
  jq -n --arg reason "oxlint reported issues across files touched this turn (read-only check; pre-commit hook will auto-fix what it can):"$'\n'"$out" '{
    decision: "block",
    reason: $reason
  }'
  exit 0
fi

exit 0
