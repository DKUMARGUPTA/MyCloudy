# Skill: security-audit — pentest-style audit of DocoPDF (authorized targets only)

> **Derived from:** [vxcontrol/pentagi](https://github.com/vxcontrol/pentagi)
> (open-source autonomous pentesting platform by VXcontrol). Pentagi's
> pipeline — recon → specialized vulnerability analysis → verified
> exploitation (benign PoC) → report — adapted here as a repeatable manual
> skill for auditing OUR OWN application.
>
> **⚠️ SCOPE (hard rule):** this skill audits DocoPDF code and DocoPDF
> deployments ONLY (`localhost:3000`, our mini-services, our Vercel app).
> Never point any part of it at third-party systems. No exploit tooling is
> shipped here — every "probe" is a read-only request or a source scan.

## When to run

| Trigger | Depth |
|---|---|
| Round touches `src/app/api/**`, `src/lib/auth*`, `mini-services/**`, `prisma/schema.prisma` | fast pass (§3 A–C) |
| Every phase boundary / before a tag | full run (§3 A–F) |
| New dependency added or `bun audit` critical | §3 D + fix |
| Security incident / weird traffic in logs | full run + 15-DEBUGGING triage |

## 1. Pentagi pipeline → our adaptation

| Pentagi stage | Pentagi does | DocoPDF equivalent |
|---|---|---|
| Recon | maps attack surface of the target | enumerate routes/models/services/headers (§3 A) |
| Vuln analysis | specialized agents probe classes | checklist probes per OWASP class (§3 B–D) |
| Exploit verify | benign PoC in isolated sandbox | curl PoC against localhost — assert status/shape only, never damage |
| Report | structured findings + severity | findings table appended to worklog round |
| Fix & re-verify | — | fix, then re-run the failing probe + regression E2E |

## 2. Severity ladder

- **P0** — fix before anything ships this round (auth bypass, RCE-class dep, secret leak).
- **P1** — fix same round (missing rate limit / validation on a mutator, header regression).
- **P2** — backlog with owner note (dev-toolchain noise, hardening ideas).

## 3. The checklist

### A. Recon — know the surface

```bash
# API surface (must match docs/rules/06-API-RULES.md inventory)
ls src/app/api/ src/app/api/admin/ src/app/api/admin/accounting/
# Data surface (must match docs/rules/05-DATA-RELATIONS.md)
rg -n "^model " prisma/schema.prisma
# Services surface
ls mini-services/            # convert :3031, request-sign :3032
# Response headers surface
curl -sI http://localhost:3000/ | rg -i "content-security|x-frame|referrer|permissions|strict-transport|opener|cross-domain"
```

Drift between reality and docs/05 or docs/06 = automatic **P1** (that is a
governance-rule violation — update the doc in the same commit).

### B. Access control (OWASP A01)

```bash
# admin routes reject guests (expect 401/403 JSON envelope, never HTML)
for r in stats users bugs messages feedback audit settings analytics; do
  curl -s -o /dev/null -w "%{http_code} /api/admin/$r\n" http://localhost:3000/api/admin/$r
done
# accounting routes reject non-admins the same way
```

Static: every `src/app/api/admin/**` route file imports `gateAdmin`
(`rg -l gateAdmin src/app/api/`). Every mutator resolves auth INSIDE
try/catch (JSON envelope rule).

### C. Input & abuse (OWASP A03/A04/A05/A07)

```bash
# rate limits fire (pick a public mutator; hammer it)
for i in $(seq 1 40); do curl -s -o /dev/null -w "%{http_code} " -X POST \
  -H 'content-type: application/json' -d '{}' http://localhost:3000/api/contact; done; echo
# → must flip to 429 with retry-after

# method discipline
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3000/api/tools
# → 405 JSON, not HTML 500

# oversized bodies rejected before buffering (Content-Length cap)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' \
  -H 'content-length: 99999999' -d '{}' http://localhost:3000/api/contact
```

Static: every public POST route either uses `src/lib/rate-limit.ts` or an
inline limiter; zod (or explicit guards) before any DB touch:
`rg -l 'rateLimit\(|rateLimited' src/app/api/` and `rg -l 'zod' src/app/api/`.

### D. Dependencies (OWASP A06)

```bash
timeout 90 bun audit 2>&1 | rg "vulnerabilities|critical:"
```

- **critical/high in RUNTIME deps** (next, zod, prisma, react…) → P0 →
  `bun update <pkg>` within range → full gates (tsc, lint, smokes, E2E).
- Toolchain-only (eslint/babel/glob ReDoS class) → P2 note, accepted.
- After ANY dependency update: re-run `bunx tsc --noEmit`,
  `bun run lint`, dev-server restart, one golden-path E2E. Plugin majors
  can activate new lint rules — configure per existing policy
  (see eslint.config.mjs R43 note), never bulk-"fix" editor surfaces in a
  security round.

### E. Secrets & config (OWASP A02/A05)

```bash
git grep -lE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-|AIzaSy[A-Za-z0-9_-]{20,}" -- . || echo clean
rg -n "env" .gitignore          # .env must be ignored
ls /home/z/.tokens/ 2>/dev/null # token store, mode 600 (may be wiped — see 18)
```

### F. Privacy audit (DocoPDF-specific, PRD §14)

- DB rows never contain file content/names (metadata-only rule).
- Beacons (`/api/usage`, `/api/analytics/view`) carry anonymous ids only —
  no IP, no raw UA; owner surfaces excluded from tracking.
- New external origin in client code = P0 (CSP `connect-src 'self'` will
  block it anyway — keep it that way).
- `PageView`/`AnonUsage`/`UsageEvent` schemas stay coarse (buckets, days).

## 4. Report format (append to worklog round)

```
SECURITY AUDIT (skill: docs/skills/security-audit) — <date>
A recon: <routes/models/headers state, doc drift y/n>
B access: <probe results>
C input: <rate-limit/method/cap results>
D deps: <audit before → after>
E secrets: <scan result>
F privacy: <result>
Findings: P0 <…> P1 <…> P2 <…> — fixed this round: <…>
```

## 5. History

- **R43 (first run):** 94 vulns → 27 (0 critical; remaining = dev-toolchain
  ReDoS class, P2 accepted). Next 16.1.3→16.4.3 (4 critical RCE advisories
  patched), zod 4.6.7, fflate 0.8.3, eslint chain. Added COOP +
  X-Permitted-Cross-Domain-Policies headers, disabled dead /_next/image
  endpoint (`images.unoptimized`). Access/input/secrets/privacy: all green
  (gateAdmin ×18, rate limits present, cookie flags HttpOnly+Lax+Secure,
  secrets scan clean).
