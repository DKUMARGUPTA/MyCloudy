# 09 · Execution Steps (canonical loop)

The same loop for a one-line fix or a full phase — scale only the middle.

## 0. Prepare

```bash
cd /home/z/my-project
tail -50 dev.log                 # server state
git log --oneline -5             # last landed work
python3 scripts/dev-daemon.py    # ensure :3000 (idempotent)
python3 scripts/mini-daemon.py convert
python3 scripts/mini-daemon.py request-sign
```

## 1. Plan

TodoWrite breakdown; mark subagent-bound items with Task IDs. Identify
which rules docs the change touches (02/04/06/11…).

## 2. Implement

- Frontend first when fullstack (user sees result early), then API.
- API = route handlers (`use api`, not server actions).
- Existing shadcn/ui components before custom; i18n keys from the start;
  workers for heavy lifting (see 02/03 rules).

## 3. Gates (ALL mandatory, in order)

```bash
bunx tsc --noEmit      # MUST be 0 errors (redirect to file; piping lies)
bun run lint           # MUST be 0
bun tsx scripts/smoke-<touched-tool>.ts   # targeted smokes green
bun tsx scripts/run-battery-chunk.sh …    # full battery for engine changes
```

A green "it compiles" is NOT done — continue to E2E.

## 4. E2E (agent-browser)

Golden path of what you built + one regression from the standing suite:
tofu rendering · sitemap URLs 200 · router anchors · branded 404 ·
palette/theme · mobile 390px no-overflow · Hindi locale clean · console
error-free. Details: `14-TESTING.md`. Screenshot to `public/qa/` for the
worklog when visual.

## 5. Document

- `worklog.md` append (template at file bottom) — what/why/evidence/gates.
- `CONTEXT-MEMORY.md` — "Updated" line + Recent Rounds entry.
- `docs/rules/*` if a contract changed (same commit).

## 6. Push (durable = pushed)

```bash
source /home/z/.tokens/docopdf.env
MYCLOUDY_GH_TOKEN=$GITHUB_TOKEN VERCEL_TOKEN=$VERCEL_TOKEN \
  bash scripts/push-github.sh
```

Script leak-scans, pushes main + tags. **Never commit/push without gates.**
If tokens are missing/wiped → record BLOCKED in CONTEXT-MEMORY, stop.

## 7. Verify production

- Vercel deploy READY (dashboard or `bash scripts/ops/status.sh`).
- Hit the changed route on https://www.docopdf.com (curl status + key
  content, or agent-browser if visual) — the user's browser is the judge.

## 8. Close

TodoWrite all-completed; cron payload refresh only if the focus changed.

## Rollback / incident

Broken prod: `git revert <sha>` (new commit, NEVER reset) → gates → push.
Sandbox disk rollback wiped work: rebuild from last GitHub tag/push; log
the incident in worklog (VERSION-SAVE precedent).
