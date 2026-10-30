#!/usr/bin/env bash
# Drain the queue from lint-post-edit.sh and run oxlint once per checkout over it,
# emitting {decision:"block"} so Claude self-corrects before the turn ends.
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

# Dedupe, then keep files that still exist AND belong to this repo, each tagged
# with the checkout it lives in. A sibling checkout has its own config and its
# own gate; linting it with this repo's config reports against rules it never
# opted into. An agent worktree nested under this repo is its own checkout too:
# it is linted from its own root, with its own binaries and config. From here,
# this repo's config ignores it, and oxlint would load the worktree's config as
# a nested one and register the same JS plugin twice.
project=$(pwd -P)
pairs=$(sort -u "$queue" | while IFS= read -r f; do
  if [ ! -f "$f" ]; then continue; fi
  dir=$(cd "$(dirname "$f")" 2>/dev/null && pwd -P) || continue
  case "$dir/" in "$project"/*) ;; *) continue ;; esac
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || root=$project
  case "$root/" in "$project"/*) ;; *) root=$project ;; esac
  printf '%s\t%s/%s\n' "$root" "$dir" "$(basename "$f")"
done)

if [ -z "$pairs" ]; then exit 0; fi

out=""
failed=0
roots=$(printf '%s\n' "$pairs" | cut -f1 | sort -u)
while IFS= read -r root; do
  if [ ! -x "$root/node_modules/.bin/oxlint" ]; then continue; fi
  files=$(printf '%s\n' "$pairs" | while IFS=$'\t' read -r r f; do
    if [ "$r" = "$root" ]; then printf '%s\n' "$f"; fi
  done)
  result=$(cd "$root" && printf '%s\n' "$files" | xargs node_modules/.bin/oxlint --deny-warnings --no-error-on-unmatched-pattern --disable-nested-config 2>&1)
  if [ $? -ne 0 ]; then
    failed=1
    if [ "$root" != "$project" ]; then out="$out$root:"$'\n'; fi
    out="$out$result"$'\n'
  fi
done <<< "$roots"

if [ $failed -ne 0 ]; then
  jq -n --arg reason "oxlint reported issues across files touched this turn (read-only check; pre-commit hook will auto-fix what it can):"$'\n'"$out" '{
    decision: "block",
    reason: $reason
  }'
  exit 0
fi

exit 0
