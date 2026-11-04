# 18 · Sandbox Resilience (wipe-recovery protocol)

**Why this doc exists:** the sandbox disk is EPHEMERAL — it has already
rolled back/wiped multiple times (tokens wiped twice: 2025-10-30 05:33 and
again later; whole-tool losses earlier). The owner's directive: *"sandbox
wipe hone par bhi konsa rule logic hoga jisse tum sab kuch yaad rakh sako —
discipline and skill ko."*

## The memory chain (what makes us wipe-proof)

```
GitHub repo (DKUMARGUPTA/MyCloudy)          ← ONLY durable layer (push!)
 └── AGENTS.md            constitution — session entry point (read FIRST)
 └── docs/rules/01…18     binding rule system (the "discipline")
 └── docs/skills/*/SKILL.md  reusable skills (pentagi-derived etc.)
 └── CONTEXT-MEMORY.md    short-term live state (refresh EVERY round)
 └── worklog.md           full round history (append EVERY round)
 └── git history + tags   permanent record (never rewrite — hard rule 6)
```

**Rule of durability: if it is not committed AND pushed, it does not exist.**
Disk-resident state (node_modules, .next, db/*.db, /home/z/.tokens, .env,
dev.log) is disposable by design.

## Per-round discipline (the price of memory)

1. `worklog.md` append (round entry, QA evidence).
2. `CONTEXT-MEMORY.md` refresh (Quick Status + Recent Rounds + pending).
   ⚠️ R41/R42 skipped this once — the next session then started from a
   stale R29 worldview. That slip is the reason this doc exists.
3. Rules-doc touch: any contract change → matching doc, SAME commit.
4. Push: `MYCLOUDY_GH_TOKEN=<pat> bash scripts/push-github.sh`
   (leak-scan built in; also pushes tags).
5. Prod spot-check after Vercel deploy settles.

## What gets lost on a wipe (recreate, don't mourn)

| Lost | How it comes back |
|---|---|
| `/home/z/.tokens/` + `.env.credentials` | owner re-pastes PAT/Vercel token once; `scripts/push-github.sh` works again |
| `.env` | `cp .env.example .env` (values are non-secret defaults) |
| `node_modules` | `bun install` (postinstall runs prisma generate) |
| `db/*.db` (QA data) | `bun run db:push` — schema rebuilds; historical QA rows are expendable |
| dev server / mini-services | `scripts/dev-daemon.py` + `scripts/mini-daemon.py convert` / `request-sign` |
| 15-min cron QA job | delete the disabled job, recreate (fixed_rate 900, webDevReview payload, priority 1, Asia/Calcutta) |
| agent-browser localStorage | may persist OR reset — always re-read to confirm in locale tests |

## Fresh-sandbox restore (one command)

```bash
MYCLOUDY_GH_TOKEN=<pat> bash scripts/restore-sandbox.sh
```

`scripts/restore-sandbox.sh` does the whole ladder: clone/pull →
`bun install` → `bun run db:push` → dev daemon → mini daemons → health
checks → prints the cron-recreate + token checklist. Idempotent: safe to
run on a half-restored sandbox.

## Token handling (hard rule 7)

- Fine-grained PAT, repository access `DKUMARGUPTA/MyCloudy`,
  Contents: Read AND WRITE. Vercel token: deploy + project scope.
- Storage: `/home/z/.tokens/` (mode 600) or exported env vars — NEVER in
  any tracked file; push script leak-scans before pushing.
- Tokens are expected to vanish on wipe. The ask-to-owner script is part
  of recovery, not an exception.

## Skills survive because they are files

A "skill" here = `docs/skills/<name>/SKILL.md` in the repo (see
`docs/skills/security-audit/` for the format: when-to-run, checklist,
commands, severity ladder, history). Anything installed outside the repo
(plugin caches, /tmp clones) is treated as scratch — if it matters,
distill it into a SKILL.md and commit.
