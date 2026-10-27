# Task TOOLS-B1-b — pdf-to-markdown (batch B1)

Full detail lives in `/home/z/my-project/worklog.md` (TOOLS-B1-b entry at
the bottom). Summary for sibling agents + the orchestrator:

## Files I own (created)
- `tools/pdf-to-markdown/md-build.ts` — PURE engine (no DOM, no pdfjs
  import): buildMdLines (pdf-to-txt baseline grouping + left-edge x +
  longest-piece size), buildHeadingContext (document-wide font-size
  clustering: body = length-weighted median; clusters with 6% tolerance;
  level = max(prev+1, ratio floor) capped 6 — biggest is #, barely-above-
  body stays ###, no fake h1), buildSegments (para/list/heading cuts:
  markers, indented wrapped-item joins, 1.35 size-ratio joins,
  dehyphenation), escapeMdText (iOS-safe char loop: \ ` * _ [ ] <
  anywhere, # > - + = ~ line-start only — Devanagari and & untouched,
  no double-escapes), blocksToMarkdown (tight lists), joinPages (empty
  pages dropped, optional ---), mdRunErrorCode (0 chars →
  "tool.errorNoText").
- `tools/pdf-to-markdown/worker.ts` — pdf.js in-worker (fake-worker +
  workerDocumentShim, pdf-to-txt recipe), two passes per file (lines+scan
  probe → heading ctx → convert), output `.md` (text/markdown), pages via
  parsePageSpec, password→errorEncrypted / else errorCorrupt.
- `tools/pdf-to-markdown/config.ts` — outputKind "text", 1–5 files,
  options: headings switch (true) / pages ("all") / pageRules (false),
  howKeys mdOut.how1-3, chainToolIds ["markdown-to-pdf", "txt-to-pdf"],
  5 features + 3 FAQ (honest limits).
- `tools/pdf-to-markdown/panel.tsx` — pdf-to-txt panel recipe with
  mdOut.* keys: live page-1 preview, word chip, scan warning, privacy
  footer.
- `tools/pdf-to-markdown/i18n.json` — section **`mdOut`**, 10 keys ×2,
  perfect en↔hi parity.
- `scripts/smoke-pdf-to-markdown.ts` — REAL artifacts: pdf-lib fixture →
  pdfjs legacy extraction under bun → engine → EXACT-markdown assert +
  variants + scan error + round-trip into markdown-to-pdf's parseMarkdown
  + i18n parity + ann-fixture sanity pass. QA assets:
  `download/qa-pdf-to-md-fixture.pdf` + `download/qa-pdf-to-md-output.md`.

## Verification
- `bun scripts/smoke-pdf-to-markdown.ts` → **63 passed, 0 failed — ALL
  GREEN**.
- `bun run lint` → 0 problems.
- `bunx tsc --noEmit` → 0 errors in ALL my files. Project-wide leftovers
  at my finish time: `tools/passport-photo/worker.ts` and
  `scripts/smoke-pdf-to-html.ts` — CONCURRENT sibling agents' in-progress
  work (I did not touch them). Note for TOOLS-B1-a: your tsc note about my
  worker.ts RawTextItem export is resolved (fixed + re-exported).

## Orchestrator wiring (NOT done — outside my ownership)
1. `src/lib/tools/configs.ts`:
   `import { config as pdfToMarkdown } from "../../../tools/pdf-to-markdown/config";`
   + `[pdfToMarkdown.toolId]: pdfToMarkdown,` next to the pdfToTxt entry.
2. `src/lib/tools/panels.tsx`:
   `import { PdfToMarkdownPanel } from "../../../tools/pdf-to-markdown/panel";`
   + `"pdf-to-markdown": PdfToMarkdownPanel,`.
3. NO TOOL_SURFACES entry — generic ToolShell suffices (outputKind "text"
   already gets the canvas text thumbnail; rename keeps .md).
4. Registry: flip the EXISTING `pdf-to-markdown` def (enabled:false →
   true) — id/name/description/icon already correct.
5. i18n merge: `tools/pdf-to-markdown/i18n.json` → section **`mdOut`**
   (10 keys ×2, parity pre-verified) into src/i18n/en.json + hi.json
   (merge-card-i18n.ts flow).
6. chainToolIds: `["markdown-to-pdf", "txt-to-pdf"]` (in my config).
7. agent-browser QA with `download/qa-pdf-to-md-fixture.pdf` — expected
   output at `download/qa-pdf-to-md-output.md`.

## Key decisions
- Heading context is DOCUMENT-wide (one pass over all pages' lines
  before converting) so levels stay consistent across pages — the
  per-page spec goal is met with better cross-page behavior.
- Size beats marker shape: "1. Introduction" in 16pt is a heading (number
  kept in the text), at body size it's an ordered list item.
- Ordered items keep their SOURCE numbers; same-kind lists render tight
  (single \n), everything else blank-line separated.
- Escaping is minimal-but-complete (pandoc-style): no noise on normal
  prose; line-start set only covers chars that would flip block
  structure at column 0.
- Devanagari PDF fixture was probed and rejected honestly (pdf-lib
  drawText does no OpenType shaping — matra reordering artifacts would
  have encoded wrong expectations); engine-level Hindi vectors cover my
  code's behavior (escaping untouched, paragraph joining, dehyphenation
  script class).
