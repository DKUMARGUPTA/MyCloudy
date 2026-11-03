#!/usr/bin/env bash
# restore-sandbox.sh — one-command recovery after a sandbox wipe.
#
# Usage:
#   MYCLOUDY_GH_TOKEN=<pat> bash scripts/restore-sandbox.sh
#   (token optional if the repo is already cloned locally and intact)
#
# Idempotent: safe to re-run on a half-restored sandbox. See
# docs/rules/18-SANDBOX-RESILIENCE.md for the full protocol.
set -uo pipefail

REPO_URL="https://github.com/DKUMARGUPTA/MyCloudy.git"
ROOT="/home/z/my-project"
cd "$ROOT" 2>/dev/null || { echo "✗ $ROOT missing — clone manually:"; echo "  git clone $REPO_URL $ROOT"; exit 1; }

step() { echo ""; echo "=== $1 ==="; }

step "1/7 git state"
if [ -n "${MYCLOUDY_GH_TOKEN:-}" ]; then
  AUTH_URL="https://x-access-token:${MYCLOUDY_GH_TOKEN}@github.com/DKUMARGUPTA/MyCloudy.git"
  echo "→ fetching remote (token provided)"
  git fetch "$AUTH_URL" main 2>&1 | tail -1 || echo "⚠ fetch failed — continuing with local tree"
  AHEAD=$(git rev-list --count origin/main..main 2>/dev/null || echo "?")
  echo "→ local commits ahead of origin/main: $AHEAD (push ritual pending if > 0)"
else
  echo "→ no token provided — using local tree only (unpushed work stays unpushed)"
fi
git log --oneline -3

step "2/7 dependencies"
if [ -d node_modules/next ]; then echo "✓ node_modules present"; else bun install || exit 1; fi

step "3/7 environment"
if [ -f .env ]; then echo "✓ .env present"; else
  cp .env.example .env && echo "✓ .env created from .env.example (defaults)"
fi

step "4/7 database schema"
bun run db:push 2>&1 | tail -2

step "5/7 dev server (:3000)"
if curl -s -o /dev/null -w "" --max-time 5 http://localhost:3000/ 2>/dev/null; then
  echo "✓ :3000 already answering"
else
  python3 scripts/dev-daemon.py && sleep 15
  curl -s -o /dev/null -w "GET / -> %{http_code}\n" --max-time 60 http://localhost:3000/ || echo "✗ dev server did not come up — check dev.log"
fi

step "6/7 mini-services (:3031 convert, :3032 request-sign)"
for svc in convert request-sign; do
  python3 scripts/mini-daemon.py "$svc" >/dev/null 2>&1 || echo "⚠ $svc daemon start reported failure (may already run)"
done
sleep 2
curl -s --max-time 5 http://localhost:3031/health 2>/dev/null | head -c 80; echo ""
curl -s --max-time 5 http://localhost:3032/health 2>/dev/null | head -c 80; echo ""

step "7/7 what a script cannot restore (manual checklist)"
cat <<'EOF'
□ 15-min cron QA job — if list shows "Disabled due to exec limits":
  delete it, recreate: fixed_rate 900s · webDevReview payload · priority 1 · tz Asia/Calcutta
  (payload text: see CONTEXT-MEMORY.md ops section / prior job)
□ /home/z/.tokens/ + .env.credentials — ask owner for fresh GitHub PAT
  (fine-grained, Contents R+W) + Vercel token, then:
  MYCLOUDY_GH_TOKEN=<pat> bash scripts/push-github.sh
□ Read AGENTS.md + docs/rules/INDEX.md + CONTEXT-MEMORY.md BEFORE any code
  (session start ritual — AGENTS.md §0)
EOF
echo ""
echo "Restore complete. Session start ritual: AGENTS.md → docs/rules/ → CONTEXT-MEMORY.md."
