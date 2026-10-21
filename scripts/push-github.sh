#!/usr/bin/env bash
# Push MyCloudy (main + all tags) to GitHub.
#
# The token must be a fine-grained PAT with:
#   Repository access: DKUMARGUPTA/MyCloudy
#   Permissions → Repository permissions → Contents: Read AND WRITE
#
# Usage:
#   MYCLOUDY_GH_TOKEN=<your-token> bash scripts/push-github.sh
#
# Why this script exists: the sandbox disk is ephemeral (it has already
# rolled back once and destroyed ~20 built tools). Until every batch is
# pushed to GitHub, work is NOT durable. Run this after EVERY batch.
set -euo pipefail

TOKEN="${MYCLOUDY_GH_TOKEN:?Set MYCLOUDY_GH_TOKEN to a PAT with Contents read+write}"
URL="https://x-access-token:${TOKEN}@github.com/DKUMARGUPTA/MyCloudy.git"

echo "→ pushing main (force: remote may hold unrelated initial commit)…"
git push --force "$URL" main

echo "→ pushing all tags…"
git push --force "$URL" --tags

echo "→ verifying remote…"
git ls-remote "https://x-access-token:${TOKEN}@github.com/DKUMARGUPTA/MyCloudy.git" \
  | sed "s/${TOKEN}/***/g" | head -8

echo "✓ pushed: main + $(git tag | wc -l) tag(s) to DKUMARGUPTA/MyCloudy"
