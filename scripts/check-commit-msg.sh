#!/bin/sh
set -eu
if grep -Eiq 'co-authored-by:.*(claude|anthropic)|claude\.ai/code|claude-session:|generated (with|by)' "$1"; then
  echo "commit message contains forbidden AI attribution" >&2
  exit 1
fi
