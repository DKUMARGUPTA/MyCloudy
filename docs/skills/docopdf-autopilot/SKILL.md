---
name: docopdf-autopilot
version: 1.0.0
description: DocoPDF (MyCloudy repo) ka har kaam — naya tool, bug fix, QA round, cron webDevReview, ya koi bhi PDF-tools project ka kaam — is skill se chalao. Use this skill EVERY time the user mentions DocoPDF, docopdf.com, PDF tools, the MyCloudy repo, a cron QA round, or asks for new tools/features/fixes in this project, even if they don't name the skill. It teaches the full autonomous round protocol: context load, agent tiers, work queue, gates, E2E, worklog, push.
changelog: R49 — initial release, derived from codebase-memory-mcp tier concepts
---

# DocoPDF Autopilot — the autonomous round protocol

> This skill makes ANY agent session (interactive or cron) self-sufficient
> on the DocoPDF project: it knows where the memory lives, how to pick
> work automatically, which specialized agent to delegate to, and how to
> close a round safely (gates → worklog → push).

## 0. Context load (BEFORE any code — mandatory order)

1. `AGENTS.md` — repo constitution (Ten Hard Rules).
2. `CONTEXT-MEMORY.md` — short-term project memory (latest state).
3. `NEXT-STEPS.md` — the auto-work queue (what to do next).
4. `dev.log` tail + `git log --oneline -5` — actual runtime state.
5. Rule docs for your scope via `docs/rules/INDEX.md`.

If any of these conflict, runtime state (dev.log/git) wins for "what is",
NEXT-STEPS wins for "what next".

## 1. Pick work automatically (the autopilot core)

- Cron/QA round: fix bugs FIRST (dev.log errors, broken E2E). Stable →
  take the top item from `NEXT-STEPS.md` queue that fits the round budget
  (skip `[owner]`-tagged items — they need approval).
- Interactive session: the user's ask wins; log new discovered work into
  NEXT-STEPS.md at round end.
- Never start a `[owner]` item or billing work (frozen) without explicit
  approval.

## 2. Delegate to specialized agents (Task tool)

Use the profiles in `docs/agents/` — pass the profile file path in the
Task prompt so the subagent reads its discipline contract:

| Need | Profile | Key discipline |
|---|---|---|
| Fast "kahan hai / kya hai" recon | `docs/agents/scout.md` | provisional findings, NO absence claims |
| Bounded implementation | `docs/agents/builder.md` | evidence-first, gates before "done" |
| Independent verification | `docs/agents/auditor.md` | re-derive evidence, disclose limitations |

Handoff must include: Task ID, tier, bounded scope, known evidence, and
the expected return format (TIER/SCOPE/FINDINGS/EVIDENCE/LIMITATIONS/
NEXT; auditor variant: VERIFIED + VERDICT). A subagent missing context
returns the exact missing query — never a guess.

## 3. New-tool anatomy (R48 proven — follow exactly)

`tools/<id>/config.ts` (+`worker.ts`, `engine.ts` if complex) →
`src/lib/tools/registry.ts` `def()` → `src/lib/tools/configs.ts` import +
map → `src/lib/seo/tool-seo.ts` curated entry → i18n keys via a merge
script (`scripts/merge-rXX-i18n.ts` pattern, en+hi parity) → smoke
script (`scripts/smoke-rXX-tools.ts` pattern, real workers via
self-shimmed globalThis). Zero new npm deps by default; own engine
(`src/lib/own/pdf`) only; typed error codes from `tool.error*` i18n keys.

## 4. Round close (never skip)

1. Gates: `bunx tsc --noEmit` = 0 · `bun run lint` = 0 · relevant smokes
   green · agent-browser E2E (golden path + console 0 errors + mobile
   spot-check).
2. `worklog.md` append (round entry with gates/E2E results).
3. `CONTEXT-MEMORY.md` refresh (status lines) + `NEXT-STEPS.md` update
   (item → DONE with commit hash; add new candidates).
4. Commit + push: `MYCLOUDY_GH_TOKEN=*** bash scripts/push-github.sh`
   (token from env/tokens dir — NEVER in files).
5. Vercel auto-deploys; verify prod routes 200 for touched surfaces.

## 5. Hard reminders (the ones agents keep forgetting)

- Sandbox preview shows only `/` — deeper routes via agent-browser +
  prod checks.
- Never `--amend`/reset pushed commits (cron race).
- Billing code frozen; AI tools re-enable only via the self-dependent
  NEXT-STEPS item 1 plan.
- i18n en/hi leaf parity is enforced — every string both languages.
- Secrets (GH/Vercel/Turso tokens) never in tracked files or worklog.
