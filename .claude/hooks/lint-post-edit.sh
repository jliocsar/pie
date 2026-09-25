#!/usr/bin/env bash
# Enqueue the touched file for the per-turn lint check. The Stop hook runs oxlint
# once over the deduped set, so repeated edits collapse into one report.
# Never mutates — .husky/pre-commit is what fixes.

set -u

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')

if [ -z "$file_path" ] || [ -z "$session_id" ]; then exit 0; fi
if [ ! -f "$file_path" ]; then exit 0; fi

case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

queue="${TMPDIR:-/tmp}/claude-lint-queue-${session_id}.list"
printf '%s\n' "$file_path" >> "$queue"
exit 0
