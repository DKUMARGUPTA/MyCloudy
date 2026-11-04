# Agent Index — DocoPDF specialized subagent profiles

> **Derived from:** [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
> (MIT) — its Scout/Verify/Auditor tier system, evidence contracts, handoff
> protocol and structured return formats, adapted for THIS repo's Task-tool
> subagents. Zero code copied; the ideas only. (Same adaptation pattern as
> `docs/skills/security-audit/SKILL.md` ← pentagi.)

## When to use which profile

| Profile | Use when | Typical Task ID suffix |
|---|---|---|
| **Scout** (`scout.md`) | Fast recon: "kahan hai X?", "kya Y exist karta hai?", impact guess before a change, locating candidates for the round | `-s` |
| **Builder** (`builder.md`) | Task-directed implementation: new tool, bug fix, feature — with evidence gates before claiming done | `-b` |
| **Auditor** (`auditor.md`) | Full verification of a finished change or a whole area: gates re-run, E2E, limitations disclosed | `-a` |

Default tier = **Builder** (Scout is for speed, Auditor for high-risk or
end-of-batch verification). A typical round: Scout locates → Builder
implements → Auditor verifies (R48-style smoke + E2E).

## The evidence ladder (all tiers)

1. **A clean result means no recorded gap — NOT proof of completeness.**
2. Scout findings are **provisional** until a Builder/Auditor confirms them
   against exact files.
3. Negative claims ("X does not exist", "nothing uses Y") require **path
   coverage**: you checked every plausible location and can list them.
4. Every report ends with a **limitations** line — what you did NOT verify.

## Handoff protocol (lead → subagent)

The lead's Task prompt must supply:
- Task ID (house rule) + tier + bounded scope
- The exact files/areas in scope (paths)
- What evidence is already known (so the child re-checks, not re-guesses)
- The expected return format (see each profile)

A subagent that lacks context must return the **exact missing query**
("run rg for X in Y") instead of guessing — guessing is the failure mode
this system exists to prevent.

## Return contracts

Every subagent returns a single final message structured as:

```
TIER: scout|builder|auditor
SCOPE: <files/areas checked, paths listed>
FINDINGS/CHANGES: <bulleted, file:line references>
EVIDENCE: <commands run, gates passed, checks green>
LIMITATIONS: <what was NOT verified — mandatory honesty>
NEXT: <exact query or step the lead should run, if any>
```

**Auditor variant** (see `auditor.md`): `VERIFIED` replaces EVIDENCE
(the re-derived check results), `FINDINGS` carries P0/P1/P2 with
evidence, and `VERDICT` (SHIP | FIX-FIRST | BLOCKED) replaces NEXT.

## Tool discipline

- Scout uses read-only tools (Read/Grep/Glob/LS) and at most ONE small
  agent-browser check. No edits, ever.
- Builder may edit files but runs gates (`tsc`, `lint`, relevant smoke)
  before reporting done.
- Auditor re-runs gates from a clean slate, does browser E2E, and greps
  for regressions — it never trusts the Builder's claim.
