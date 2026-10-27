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

# ── TOKEN-LEAK GUARD (defense in depth) ──────────────────────────────────
# Refuse to push if ANY tracked file contains the GitHub or Vercel token
# values. Gitignore protects untracked paths; this catches accidents where
# a token got pasted into source/docs.
LEAK_SCAN=$( { git grep -l -- "$TOKEN" 2>/dev/null || true; } )
VC_TOKEN="${VERCEL_TOKEN:-}"
VC_LEAK=""
if [ -n "$VC_TOKEN" ]; then
  VC_LEAK=$( { git grep -l -- "$VC_TOKEN" 2>/dev/null || true; } )
fi
if [ -n "$LEAK_SCAN" ] || [ -n "$VC_LEAK" ]; then
  echo "✗ FATAL: token found in tracked files — ABORTING push:"
  [ -n "$LEAK_SCAN" ] && echo "  GitHub token in: $LEAK_SCAN"
  [ -n "$VC_LEAK" ]   && echo "  Vercel token in: $VC_LEAK"
  exit 1
fi
echo "✓ token-leak guard: clean (no secrets in tracked files)"

echo "→ pushing main (force: remote may hold unrelated initial commit)…"
git push --force "$URL" main

echo "→ pushing all tags…"
# --force --tags can transiently fail with "remote rejected (failed)"
# (observed once on a fresh tag after main already pushed); retry the
# atomic push once, then fall back to per-tag pushes so one bad ref
# can never block the others.
if ! git push --force "$URL" --tags; then
  echo "⚠ bulk tag push failed — retrying per-tag…"
  failed=0
  for tag in $(git tag); do
    git push --force "$URL" "refs/tags/${tag}:refs/tags/${tag}" || {
      echo "✗ tag ${tag} failed"
      failed=1
    }
  done
  [ "$failed" -eq 0 ] || exit 1
fi

echo "→ verifying remote…"
git ls-remote "https://x-access-token:${TOKEN}@github.com/DKUMARGUPTA/MyCloudy.git" \
  | sed "s/${TOKEN}/***/g" | head -8

echo "✓ pushed: main + $(git tag | wc -l) tag(s) to DKUMARGUPTA/MyCloudy"
