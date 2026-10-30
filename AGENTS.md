# AGENTS.md — DocoPDF Master Protocol (MANDATORY ENTRY POINT)

> **Every agent, session, cron round, or human contributor MUST read this file
> first and follow `docs/rules/` before touching anything.**
> This is the repo's constitution. Ignorance of a rule is never an excuse —
> if you are unsure, re-read the referenced rule doc.

**Product:** DocoPDF (https://www.docopdf.com) — "Har PDF kaam, ek jagah.
Fast, free, private." 100 live tools, English + हिंदी, files stay on the
user's device.

**Repo:** `DKUMARGUPTA/MyCloudy` (main branch) → Vercel auto-deploy.
**Source of truth docs:** `docs/PRD-v2.md` (WHAT) · this file + `docs/rules/`
(HOW) · `CONTEXT-MEMORY.md` (live state) · `worklog.md` (round history).

---

## 0. Session Start Ritual (do this BEFORE any code)

1. Read `AGENTS.md` (this file) + `docs/rules/INDEX.md`.
2. Read `CONTEXT-MEMORY.md` — it is the short-term memory of the project.
3. Check `dev.log` tail + `git log --oneline -5` to know the actual state.
4. Plan with TodoWrite; identify parallelizable steps before writing code.

## 1. The Ten Hard Rules (violations = round is invalid)

| # | Rule |
|---|------|
| 1 | **Metadata only.** Never store PDF content or file names in any DB. |
| 2 | **No third-party origins.** CSP `connect-src 'self'`; no CDNs; all engines self-hosted in `/public`. |
| 3 | **i18n parity.** Every UI string via i18n keys; `en.json` / `hi.json` must stay key-equal (flat leaves). Plurals: ONLY `=N` + `other` (ICU `one {}` renders tofu). |
| 4 | **Gates before push.** `tsc 0` + `eslint 0` + tool smokes green + E2E golden path via agent-browser. No exceptions. |
| 5 | **Push after every batch.** Sandbox disk is ephemeral — unpushed work can vanish. `scripts/push-github.sh`. |
| 6 | **Never rewrite git history** (no `--amend`/reset on pushed commits). New commits only. Cron + main session can race. |
| 7 | **Secrets never in repo.** Tokens live in `/home/z/.tokens/` (mode 600) or env vars; leak-scan runs in push script. Never print tokens. |
| 8 | **Error honesty.** API errors return the JSON envelope, never leak `String(err)` internals to clients. |
| 9 | **On-device processing.** Mode-D tools make ZERO network requests with file data (Web Workers only). |
| 10 | **Follow the rules docs.** Design/API/Auth/Testing/Debugging rules in `docs/rules/` are binding for every change. |

## 2. Rules Catalog (`docs/rules/`)

Read the docs relevant to your task — all of them at least once:

| Doc | Topic |
|-----|-------|
| `docs/rules/INDEX.md` | Catalog + update protocol |
| `docs/rules/01-PRD.md` | Product requirements (PRD v2 distillation) |
| `docs/rules/02-DESIGN-RULES.md` | UI/UX, tokens, a11y, responsive, i18n UX |
| `docs/rules/03-ARCHITECTURE.md` | System architecture + processing modes |
| `docs/rules/04-FOLDER-STRUCTURE.md` | Where files go; tool folder anatomy |
| `docs/rules/05-DATA-RELATIONS.md` | Prisma models + relations |
| `docs/rules/06-API-RULES.md` | Route inventory + JSON contracts + limits |
| `docs/rules/07-AGENT-PROTOCOL.md` | How agents work, commit, document |
| `docs/rules/08-PLAN.md` | Roadmap + current priorities |
| `docs/rules/09-EXECUTION-STEPS.md` | Step-by-step: build → gates → push → verify |
| `docs/rules/10-FEATURES.md` | Feature inventory (what is LIVE) |
| `docs/rules/11-AUTH-RULES.md` | Sessions, admin gates, password policy |
| `docs/rules/12-MCP-TOOLS.md` | AI skills (LLM/VLM/TTS/ASR), browser QA, cron |
| `docs/rules/13-INTEGRATIONS.md` | GitHub, Vercel, GA4, gateway, mini-services |
| `docs/rules/14-TESTING.md` | Battery, E2E, regression suite |
| `docs/rules/15-DEBUGGING.md` | Runbook for the known failure modes |

## 3. Minimum Viable Round (even small fixes)

```
read rules → todo → implement → tsc 0 → lint 0 → relevant smokes
→ agent-browser E2E (golden path + one regression) → worklog append
→ CONTEXT-MEMORY refresh → push-github.sh → prod spot-check
```

Full details: `docs/rules/09-EXECUTION-STEPS.md`.

## 4. When Rules Conflict

Product safety (rule 1, 2, 7, 9) > user-visible correctness > gates >
speed. If the user asks for something that violates a hard rule, explain
why and propose the closest compliant alternative.
