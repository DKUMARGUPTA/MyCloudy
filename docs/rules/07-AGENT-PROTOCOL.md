# 07 · Agent Protocol

Binding conduct for AI agents (cron webDevReview rounds, subagents, main
session) working in this repo.

## Specialized subagent tiers (R49)

Multi-step delegation uses the profiles in **`docs/agents/`** (derived
from codebase-memory-mcp's Scout/Verify/Auditor system):

- **Scout** — fast read-only recon; findings labeled provisional; NO
  absence/all/none/dead-code claims; at most one browser check.
- **Builder** (default) — bounded implementation; reads rule docs first;
  runs gates before claiming done; scope gaps → exact question, not
  invention.
- **Auditor** — independent verification; re-derives all gate evidence;
  P0/P1/P2 findings with reproduction; limitations section mandatory;
  never fixes.

Every Task-tool handoff carries: Task ID + tier + bounded scope + known
evidence + expected return format (TIER/SCOPE/FINDINGS/EVIDENCE/
LIMITATIONS/NEXT; auditor variant: VERIFIED + VERDICT). A subagent
missing context returns the exact missing query instead of guessing.
Full contracts: `docs/agents/INDEX.md`.

The **`docs/skills/docopdf-autopilot/SKILL.md`** skill (tracked;
auto-triggering copy at `skills/docopdf-autopilot/`, gitignored platform
dir) encodes the complete round protocol for any session (context load
order, work picking, delegation, round close).

## Identity & task IDs

- Multi-step work is planned with TodoWrite; items assigned to subagents
  get a **Task ID** (`1`, `2-a`, `2-b`, `3`…) reflecting global order and
  parallelism; the ID is passed to the subagent explicitly.
- Parallel independent subagent calls go in ONE message.
- Subagent reports are not user-visible — the lead summarizes.

## Round lifecycle (cron webDevReview, every 15 min)

1. Read `AGENTS.md` + `docs/rules/INDEX.md` + `CONTEXT-MEMORY.md` +
   **`NEXT-STEPS.md`** (the auto-work queue).
2. Assess real state: `dev.log` tail, `git log -5`, service health.
3. QA with agent-browser first; fix bugs before new features.
4. If stable: take the TOP `NEXT-STEPS.md` queue item that fits the round
   budget (skip `[owner]`-tagged items) — small, gated, shippable.
5. Gates → worklog → CONTEXT-MEMORY → NEXT-STEPS update (item → DONE
   with commit hash; new candidates added) → push
   (see `09-EXECUTION-STEPS.md`).

## Commit discipline

- Conventional-ish prefixes: `feat|fix|chore|docs(scope): summary`.
- One logical change-set per commit; docs updates can ride the same commit
  as the behavior change they document.
- **NEVER rewrite history** (`--amend`, rebase, reset of pushed commits) —
  cron and main session race; a double-amend already bit us (P6-n).
- Tags: annotated checkpoints only at owner-requested milestones.

## Documentation duties (same round, not "later")

| Event | Must update |
|-------|-------------|
| Behavior/contract change | matching `docs/rules/*` doc |
| New hard lesson (bug class) | `15-DEBUGGING.md` + CONTEXT-MEMORY pinned lessons |
| Phase/feature done | `08-PLAN.md`, `10-FEATURES.md` |
| Every round | `worklog.md` append (template at its bottom) + CONTEXT-MEMORY refresh |

## Secrets & safety

- Tokens live in `/home/z/.tokens/` (mode 600) or env; NEVER in tracked
  files, NEVER printed, NEVER in worklogs. Push script leak-scans anyway.
- `z-ai-web-dev-sdk` is BACKEND-ONLY (API routes / mini-services) — never
  imported client-side.
- Do not run `bun run build` in the sandbox (dev server + Vercel handle
  builds); do not bind ports other than the sanctioned ones.

## Sandbox operating rules

- Dev server: `python3 scripts/dev-daemon.py` ONLY (OOM reaper history);
  it owns port 3000.
- Mini-services: `python3 scripts/mini-daemon.py convert|request-sign`.
- Only `/` renders in the sandbox preview; deeper paths are verified via
  agent-browser E2E and production (docopdf.com) post-push.
- Cron QA job: if "Disabled due to exec limits" → delete and recreate
  (webDevReview, fixed_rate 900s, priority 1, Asia/Calcutta).

## Escalation

Blocked > 1 round on a gate (e.g. token missing) → record BLOCKED state in
CONTEXT-MEMORY "Kya pending hai" and stop touching that path. Do not
half-apply workarounds.
