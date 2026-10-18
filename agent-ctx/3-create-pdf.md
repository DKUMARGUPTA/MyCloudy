# Task 3 — create-pdf ("Create PDF" / पीडीएफ़ बनाएँ) — 61st tool

Agent: full-stack-developer (create-pdf subagent)
Status: SHIPPED — smoke 86/86, tsc/lint/dev.log clean, QA (EN + HI + mobile) passed.

## What was built

Instant ready-made paper & planner PDFs — no document, no word-processor
(the write-pdf noFile + surface-driven-worker-run pattern, exactly).

- `tools/create-pdf/model.ts` — PURE layout math (bun-testable, no DOM/pdf-lib):
  `CSpec` wire format, `sanitizeCSpec` (every field clamped/enum-checked),
  `planPages(spec)` → `{pages, width, height, needNoto}` where each page is
  plain data `{lines, dots, rects, labels}` in PDF pt (bottom origin).
  - lined: college 7.1mm / wide 8.7mm / narrow 6.35mm rules + optional red
    margin rule at left+24pt
  - grid: 5mm / 2.5mm mesh, centered anchor so partial cells split evenly
    while spacing stays EXACT
  - dotted: 5mm dot grid (r 0.75pt)
  - cornell: cue column min(180pt, 35% content) + summary strip
    min(144pt, 25% height) + optional header line (top−36) + optional red rule
  - planner: 7 day rows (rowH = (contentH − notesH)/7, notesH = min(110, 18%)),
    localized day labels (C_DAY_NAMES en/hi), notes label, faint writing lines
  - `cOutputName` — localized base names (`weekly-planner-a4.pdf`,
    `साप्ताहिक-प्लानर-a4.pdf`) + landscape suffix
  - pages clamp: 1–50 (planner 1–12, one week per page) via `maxPagesFor`
- `tools/create-pdf/worker.ts` — pdf-lib painter: drawLine for rules,
  filled `drawEllipse({xScale: r, yScale: r})` for dots (pdf-lib has no
  drawCircle), drawText for labels (Helvetica standard-14; embedded Noto
  Devanagari via stamp-common `loadStampFonts` ONLY when hi planner),
  progress per page, result Blob + detail `{files, pages}`.
- `tools/create-pdf/surface.tsx` — renders on the landing page (noFile):
  6 template cards with pure-CSS mini previews, options fieldset (paper size /
  orientation / pages / margin + template-specific line spacing, grid size,
  red-margin switch, header-line switch), a scaled LIVE PREVIEW driven by the
  same planPages output (560px cap), big Create PDF CTA that spawns the tool's
  real Worker, progress bar, downloadBlob + success chip.
- `tools/create-pdf/config.ts` — ToolConfig noFile, howKeys create.how1-3,
  5 features + 3 FAQ (en+hi), chainToolIds write/edit/view.
- i18n: `tools/create-pdf/i18n.json` "create" section, 49 keys ×2, merged via
  `scripts/merge-create-pdf-i18n.ts` → en/hi parity 1824 = 1824.
- Wiring: registry `create-pdf` enabled:true (+ honest description update),
  configs.ts, surfaces.tsx.

## Verification

- `scripts/smoke-create-pdf.ts`: **86/86 GREEN** (54 pure model + 32 real
  worker, incl. zlib-inflated content-stream op checks and a Type0 font
  assert for the Devanagari planner subset).
- `bunx tsc --noEmit` clean, `bun run lint` clean, dev.log clean.
- agent-browser QA: EN landing/cards/options-switching/CTA byte-verified
  (lined-paper-a4.pdf), full Hindi UI + Devanagari planner labels (preview
  font + embedded Noto in output, pdf.js read-back), landscape select via the
  Radix pointer-sequence recipe, mobile 375×812 overflowX 0 (EN + HI),
  zero console errors, zero non-localhost requests.

## Bugs found & fixed (worth knowing for future tasks)

1. **write-pdf live-preview lines were vertically mirrored** — write-pdf's
   `LLine.y` is PDF bottom-origin (verified empirically), but its preview
   rendered `top: line.y1 * previewScale` without the `pageH − y` flip, so
   underlines / hr / table borders landed at the wrong end of the preview
   page. Fixed with the proper flip (both orientations). write-pdf smoke
   regression still 95/95.
2. **Mobile horizontal overflow in my own surface** — the preview `figure`
   grid item had default `min-width: auto`, so the fixed-width preview child
   (560px) expanded the grid column past a 375px viewport (overflowX 201).
   Fixed with `min-w-0` on the figure + a 560px preview scale cap.

## Known limitation (documented, inherited from the stack recipe)

Devanagari day labels render correctly (visual) but text EXTRACTION from the
output reorders pre-base i-matras (शनिवार → शिनवार on copy) — the same
documented v1 limitation as write-pdf/stamp (pdf-lib drawText + fontkit
visual glyph order). Print/visual use is unaffected.

## Files touched

- NEW: tools/create-pdf/{model,worker,surface,config,i18n.json}
- NEW: scripts/{merge-create-pdf-i18n,smoke-create-pdf}.ts
- EDIT: src/lib/tools/registry.ts (create-pdf enabled + copy),
  src/lib/tools/configs.ts, src/lib/tools/surfaces.tsx,
  src/i18n/en.json + hi.json (via merge script),
  tools/write-pdf/surface.tsx (preview line-y fix),
  CONTEXT-MEMORY.md + worklog.md (handover)
