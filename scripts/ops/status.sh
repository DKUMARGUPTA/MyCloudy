#!/usr/bin/env bash
# DocoPDF ops status — one dashboard for everything the maintainer tracks:
#   1. GitHub token + API rate limit (resets hourly)
#   2. Vercel token + deployment health (last 5) + live URL
#   3. Sandbox disk / memory / dev-server health
#   4. Local repo hygiene (uncommitted files, battery last run)
#
# Credentials live OUTSIDE the repo in /home/z/.tokens/docopdf.env (chmod 600).
# Usage: bash scripts/ops/status.sh
set -u

ENV_FILE="${HOME}/.tokens/docopdf.env"
BACKUP_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.ops/token-backup.env"

# SELF-HEAL: sandbox environment resets can wipe ~/.tokens. If the live env
# file is missing but our gitignored backup exists, restore it automatically
# (this exact silent failure already happened once — 2025-01 session).
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$BACKUP_FILE" ]]; then
    mkdir -p "${HOME}/.tokens"
    cp "$BACKUP_FILE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "⚠ SELF-HEALED $ENV_FILE from .ops/token-backup.env (was wiped by an environment reset)"
  else
    echo "FATAL: $ENV_FILE missing AND no backup at $BACKUP_FILE."
    echo "       Recreate BOTH: put GITHUB_TOKEN=... VERCEL_TOKEN=... in $ENV_FILE,"
    echo "       then copy it to $BACKUP_FILE (chmod 600)."
    exit 1
  fi
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

hr() { printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }

hr "GITHUB (DKUMARGUPTA/MyCloudy)"
gh_api() {
  curl -s -m 12 -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" "$1"
}
gh_api "https://api.github.com/rate_limit" | python3 -c "
import json,sys,time
try:
  d=json.load(sys.stdin)['resources']['core']
  mins=int((d['reset']-time.time())/60)
  pct=100*d['remaining']//d['limit']
  bar='█'*(pct//10)+'·'*(10-pct//10)
  print(f'  API quota : [{bar}] {d[\"remaining\"]}/{d[\"limit\"]} (resets in {mins}m)')
except Exception as e: print('  API quota : ERROR', e)
"
gh_api "https://api.github.com/repos/DKUMARGUPTA/MyCloudy/commits?per_page=1" | python3 -c "
import json,sys
try:
  c=json.load(sys.stdin)[0]
  print(f'  last push : {c[\"sha\"][:7]} {c[\"commit\"][\"message\"].splitlines()[0][:58]}')
except: print('  last push : ERROR')
"

hr "VERCEL (project: ${VERCEL_PROJECT:-mycloudy})"
vc_api() {
  curl -s -m 12 -H "Authorization: Bearer ${VERCEL_TOKEN}" "$1"
}
vc_api "https://api.vercel.com/v6/deployments?app=${VERCEL_PROJECT:-mycloudy}&limit=5" | python3 -c "
import json,sys,time
try:
  deps=json.load(sys.stdin).get('deployments',[])
  if not deps: print('  (no deployments)')
  for x in deps:
    age=int((time.time()*1000-x.get('created',0))/60000)
    st=x.get('state','?')
    icon={'READY':'✅','ERROR':'❌','BUILDING':'🔨','QUEUED':'⏳','CANCELED':'🚫','INITIALIZING':'⏳'}.get(st,'❓')
    msg=(x.get('meta',{}) or {}).get('githubCommitMessage','') or x.get('name','')
    print(f'  {icon} {st:12} {age:5}m ago  {msg.splitlines()[0][:52]}')
    if st=='READY': print(f'      ↳ live: https://{x.get(\"url\",\"\")}')
except Exception as e: print('  deployments: ERROR', e)
"

hr "SANDBOX (build machine)"
df -h / | awk 'NR==2{printf "  disk : %s used / %s free (%s)\n",$3,$4,$5}'
free -m | awk 'NR==2{printf "  mem  : %dMB used / %dMB free\n",$3,$7}'
if curl -s -o /dev/null -m 3 http://localhost:3000; then
  echo "  dev  : ✅ up on :3000"
else
  echo "  dev  : ❌ DOWN — restart: python3 scripts/dev-daemon.py"
fi
UNCOMMITTED=$(git status --short 2>/dev/null | grep -cv '^??' || true)
UNTRACKED=$(git status --short 2>/dev/null | grep -c '^??' || true)
echo "  git  : ${UNCOMMITTED} modified, ${UNTRACKED} untracked"

hr "TOKEN AGES"
python3 - << PYEOF
from datetime import date
for name, added in [("GitHub","${GITHUB_TOKEN_ADDED:-?}"),("Vercel","${VERCEL_TOKEN_ADDED:-?}")]:
    try:
        days=(date.today()-date.fromisoformat(added)).days
        print(f"  {name:7}: {days} day(s) old (added {added})")
    except Exception:
        print(f"  {name:7}: age unknown ({added})")
PYEOF
echo ""
