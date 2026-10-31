# docs/rules — Index & Update Protocol

Governance layer for DocoPDF (`DKUMARGUPTA/MyCloudy` → docopdf.com).
Created on the owner's mandate: *"har update ke samay in sabhi rules follow
karne hain — jo missing hai banao."*

## Read order for a new agent

1. `/home/z/my-project/AGENTS.md` (constitution — always first)
2. `01 → 15` below, at minimum the ones touching your task
3. `CONTEXT-MEMORY.md` (live state) before writing any code

## Catalog

| # | File | Governs |
|---|------|---------|
| 01 | `01-PRD.md` | Product scope, personas, hard product rules |
| 02 | `02-DESIGN-RULES.md` | Visual system, layout, a11y, i18n UX |
| 03 | `03-ARCHITECTURE.md` | Layers, processing modes, engines, gateway |
| 04 | `04-FOLDER-STRUCTURE.md` | Directory conventions, tool anatomy |
| 05 | `05-DATA-RELATIONS.md` | Prisma schema, relations, metadata-only rule |
| 06 | `06-API-RULES.md` | API surface, error contracts, rate limits |
| 07 | `07-AGENT-PROTOCOL.md` | Agent conduct: planning, commits, docs |
| 08 | `08-PLAN.md` | Roadmap: done / next / deferred |
| 09 | `09-EXECUTION-STEPS.md` | Canonical build→gate→push→verify loop |
| 10 | `10-FEATURES.md` | LIVE feature inventory (100 tools etc.) |
| 11 | `11-AUTH-RULES.md` | Session auth, admin, abuse defenses |
| 12 | `12-MCP-TOOLS.md` | AI skills, browser QA tooling, cron |
| 13 | `13-INTEGRATIONS.md` | GitHub/Vercel/GA4/gateway/mini-services |
| 14 | `14-TESTING.md` | Quality gates, smokes, E2E, regressions |
| 15 | `15-DEBUGGING.md` | Failure-mode runbook |
| 16 | `16-BILLING-RESEARCH.md` | Competitor pricing research + 50%-below strategy (PROPOSAL — not implemented) |
| 17 | `17-ACCOUNTING.md` | Accounting module: double-entry books, GST invoicing, reports |

## Update protocol (who edits these)

- **Behavior change landed in code** (new gate, new limit, new contract) →
  update the matching rule doc **in the same commit**.
- **New hard lesson** (a bug class that bit us) → `15-DEBUGGING.md` +
  `CONTEXT-MEMORY.md` pinned lessons.
- **Phase done** → `08-PLAN.md` + `10-FEATURES.md` statuses.
- Never delete history sections; append with dates.
- Rule docs must stay **short and factual** — links and tables, not essays.
  If a doc exceeds ~150 lines, split it.

## Doc hygiene

- These files are part of the repo → same push ritual, same gates.
- No secrets, no tokens, no user data in any doc. Ever.
- Cross-reference by relative path (`../PRD-v2.md`, `../../src/lib/auth.ts`).
