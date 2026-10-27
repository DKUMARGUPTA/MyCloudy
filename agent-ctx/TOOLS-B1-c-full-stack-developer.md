# TOOLS-B1-c — pdf-to-html (full-stack-developer subagent)

Task: Build the `pdf-to-html` tool (text-based PDF → ONE self-contained .html
file) for DocoPDF batch B1. 100% on-device in a Web Worker, no server uploads.
Shared files untouched (registry stays `enabled: false` — wiring is a later
round).

## Files created

| Path | Purpose |
| --- | --- |
| `tools/pdf-to-html/html-emit.ts` | Pure engine: pdf.js items → lines (gap-aware) → blocks (h1-h3 clustering, paragraphs, ul/ol, pre) → complete self-contained HTML. All escaping lives here. |
| `tools/pdf-to-html/worker.ts` | Worker entry + exported `runPdfToHtml(data, options, openDoc, onProgress)` (openDoc injected → smoke runs the worker's own code in bun) + `HtmlRunError` (i18n codes: errorEncrypted / errorCorrupt / errorInvalidPages / errorNoText). |
| `tools/pdf-to-html/config.ts` | ToolConfig: outputKind "text", minFiles 1 / maxFiles 5, options `pages` + `pageMarks` switch, howKeys `htmlOut.how1-3`, chainToolIds `["html-to-pdf", "txt-to-pdf"]`. |
| `tools/pdf-to-html/i18n.json` | `htmlOut` section (how1-3), perfect en↔hi parity (natural Devanagari). |
| `scripts/smoke-pdf-to-html.ts` | 130 checks, ALL GREEN, real artifacts in `download/`. |

Artifacts: `download/smoke-pdf-to-html-fixture.pdf`,
`download/smoke-pdf-to-html-output.html`.

## Key decisions (so the next agent doesn't relitigate)

- **Gap carriers**: pdf.js emits BOTH whitespace-only items whose `width`
  covers the gap (pdf-lib output — found by probe) AND plain x-jumps.
  `buildLinesWithGaps` handles both; `<pre>` keeps gaps as proportional
  spaces (0.6em mono advance).
- **Heading levels**: gate = ≤2 lines, ≥1.22× body size, ≤90 chars; then
  h1 if ≥1.7× body OR ≥0.95× page max ("biggest text per page"), h2 ≥1.35×,
  else h3. Body = length-weighted median (copy-from-pdf idea).
- **Lists**: marker + space required (`3.14 is pi`, `-5`, bare `1.` are never
  lists). Consecutive same-kind markers share one `<ul>`/`<ol>`.
- **chainToolIds**: `pdf-to-txt` REJECTED — chained outputs bypass the
  drop-zone but pdf-to-txt's worker needs a real PDF (a .html would land
  `tool.errorCorrupt`; type-lie per config-types.ts comment). `html-to-pdf`
  (pending) is the round-trip: renders with the Soon badge + coming-soon
  toast. `txt-to-pdf` accepts text files.
- **Security**: `escapeHtml` (& < > " ', & first, split/join) on EVERY user
  string including `<title>`; `stripControls` removes invalid-in-HTML C0/DEL.
  Smoke proves zero raw `<script` / `<b>` sequences in the output.
- **iOS-safe** (IOS-COMPAT lesson): no matchAll/replaceAll/lookbehind/
  hasOwn/structuredClone anywhere in worker code.
- **No-text PDFs**: same honest path as pdf-to-txt — `tool.errorNoText` with
  the file name as detail.

## Verification

- `bun scripts/smoke-pdf-to-html.ts` → **130 passed, 0 failed**
- `bunx tsc --noEmit` → 0 errors in my files (project-wide: only 4
  pre-existing/concurrent errors in `tools/passport-photo/` — sibling batch
  agent's work, untouched per the no-shared-edits rule)
- `bun run lint` → 0 problems
- `dev.log` clean

## Exact wiring entries (for the wiring round)

1. `src/lib/tools/configs.ts`:
   `import { config as pdfToHtml } from "../../../tools/pdf-to-html/config";`
   + `[pdfToHtml.toolId]: pdfToHtml,` in `TOOL_CONFIGS`.
2. `src/lib/tools/registry.ts`: the existing `pdf-to-html` entry → add
   `enabled: true`.
3. Panel: none needed — generic shell renders it; text/html outputs get
   text thumbnails; result view's "Open preview" opens the .html in a tab.
4. i18n: merge `tools/pdf-to-html/i18n.json` section `htmlOut` into
   `src/i18n/en.json` + `hi.json` (merge-card-i18n.ts pattern).
5. chainToolIds already set: `["html-to-pdf", "txt-to-pdf"]`.

## Caveats

Text-only v1: no images/tables/columns (stated in features + FAQ with the
Extract-images / OCR pointers). `<pre>` needs ≥2/3 of lines with wide
internal gaps — short brace-only code lines degrade to `<p>`. Multi-column
layouts degrade to reading order (same honesty as pdf-to-txt flow).
