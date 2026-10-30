# 14 · Testing Rules

Testing philosophy: **gates + battery + E2E golden paths + standing
regressions.** No test frameworks were added (house choice); smokes are
plain `bun tsx scripts/smoke-*.ts` scripts with hard asserts.

## Gates (every round, no exceptions)

1. `bunx tsc --noEmit` → 0 errors (redirect to file; piped exit codes lie).
2. `bun run lint` → 0.
3. Targeted smokes for every touched tool/engine.
4. agent-browser E2E golden path (build a thing → prove it works in a
   real browser). "Compiles + server up" is NEVER done.

## Smoke battery

- ~110 scripts: 108 tool smokes + a11y-names + magic-bytes gates.
- `scripts/run-battery-chunk.sh` for batches; full battery for engine or
  cross-cutting changes.
- Engine changes need **dual-parser oracle** verification: own-engine
  output re-parsed by `@cantoo/pdf-lib` or pdf.js with byte-level asserts.
- When you change a shared signature, grep ALL smoke callers (cross-smokes
  like view-outline have caught real breakage the battery missed once).

## Standing E2E regression suite (agent-browser, every shipped change)

| Check | Expect |
|-------|--------|
| Home renders, light+dark | no blank screen, no error boundary |
| Tofu check (Hindi string) | Devanagari glyphs render, no □ |
| Sitemap spot URLs (`/tool/<id>`, `/hi/...`) | HTTP 200, SSR meta present |
| Router anchor links | no home-jump on tool pages |
| Branded 404 | bilingual DocoPDF page (not Next default) |
| Palette/theme | tokens only, dark mode designed |
| Mobile 390px | no horizontal overflow |
| Console | zero errors |

Record proof: screenshot → `public/qa/<round>-<what>.png`.

## E2E interaction rules (agent-browser quirks)

- Pointer: down → 150ms wait → moves → up (same-tick dispatch = stale
  gesture). Menus: `focus()` + Enter. Toasts: `ol.fixed > li`.
- Locale forcing for QA: `localStorage["docopdf-locale"] = "hi"`.
- After fixes, RE-RUN the failed check — never claim from memory.

## What is NOT tested (known gaps — don't fake it)

- No unit-test framework; business logic is covered by smokes instead.
- Load/stress tests absent — rate limits are config-level, not verified
  under traffic.
- If a flow cannot be verified in the sandbox browser (e.g. WebGL, real
  camera), SAY SO in the worklog instead of claiming success.

## Battery additions

New tool → new `smoke-<id>.ts` with: happy path, malformed input,
i18n-string presence, byte-level output assertion (or dual-parser reload).
New API route → smoke asserting the JSON error envelope (401/403/429/500
paths), not just the happy path.
