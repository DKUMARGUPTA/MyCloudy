# 15 · Debugging Runbook

Ordered diagnostics for the known failure modes. Add new lessons at the
bottom (dated); promote recurring ones to CONTEXT-MEMORY pinned lessons.

## First 5 minutes (anything broken)

1. `tail -100 /home/z/my-project/dev.log` — runtime errors, API failures,
   hydration mismatches from the last visit.
2. `git log --oneline -5` — did a cron round land something mid-session?
3. Service health: `curl -s localhost:3000` (app),
   `curl -s localhost:3031/health`, `curl -s localhost:3032/health`.
4. `bash scripts/ops/status.sh` — disk/mem/quota/git hygiene.
5. Only then start changing things.

## Known failure modes → fixes

| Symptom | Cause → Fix |
|---------|-------------|
| :3000 down / OOM-killed | tool reaper + Turbopack memory → `python3 scripts/dev-daemon.py` (ONLY this; plain nohup gets reaped) |
| :3031/:3032 dead | mini-services reaped between sessions → `python3 scripts/mini-daemon.py convert` / `request-sign` (double-fork, survives) |
| tsc "passes" but CI fails | piped exit code swallowed → redirect tsc output to a file and check it |
| Next types stale / phantom errors | `.next/dev/types` stale → `rm -rf .next/dev/types`, restart daemon |
| webpage2pdf/html2pdf ENOENT | Chrome binary path drift (155→156) — convert service auto-detects; if new breakage, check `/usr/bin/google-chrome*` |
| Hydration mismatch on /hi | Fast-Refresh artifact — clean daemon restart; locale set via rAF-deferred commit |
| Infinite loop / frozen UI | `useSyncExternalStore` returned a fresh snapshot → return cached module-level ref |
| Hindi text invisible / blanks in image-PDFs | pdf.js canvas in worker → use `loadPdfjsInWorker` + `workerDocumentShim` + `ownerDocument` param (never inline loader) |
| Silent dropped images | pdf-lib/own-engine embeds are async — awaited embedPng/embedJpg; `drawImage` width/height only |
| Text search misses | show-text ops are HEX — inflate + hex compare, never raw latin1 includes() |
| ObjStm/xref weirdness | pair table is (num, BODY-OFFSET); xref self-row offset recorded BEFORE building rows; compressed /AcroForm must reload-parse |
| Redaction leaks data | never `rewriteDocument` for redaction — collectRewriteObjects rides all xref entries; use writeDocument pages+synthetics path |
| Vercel build fails, local fine | ghost imports in `scripts/**` typecheck on Vercel → committed tree must be clean; `scripts/dev/` throwaway probes included |
| Cron job vanished | "Disabled due to exec limits" → delete + recreate webDevReview (fixed_rate 900s, priority 1) |
| Push refused (leak scan) | a token value reached a tracked file → remove + rotate token BEFORE any further push |
| Prod broken after deploy | `git revert <sha>` (new commit) → gates → push; never reset/amend |

## Root-cause discipline

- Fix the cause, not the symptom; a workaround needs a follow-up todo.
- Every debug session that produced a new class of bug → one line here +
  CONTEXT-MEMORY pinned lesson (⚠️ section).
- Evidence over vibes: byte captures, parser dumps, screenshots
  (`public/qa/`) into the worklog entry.
