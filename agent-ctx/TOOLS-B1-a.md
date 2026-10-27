# Task TOOLS-B1-a — pdf-to-webp (batch B1)

Full detail lives in `/home/z/my-project/worklog.md` (TOOLS-B1-a entry at the
bottom). Summary for sibling agents + the orchestrator:

## Files I own (created/edited)
- `tools/pdf-to-images/formats.ts` (NEW) — family format table (jpg/png/webp:
  mime/ext/alpha/lossy/verifyMime/parseQuality) + pure naming helpers
  (`pdfBaseName`, `pageOutputName`) + `parsePercentQuality` (jpg, byte-identical
  to the old inline math) + `parseWebpQuality` (webp select values).
- `tools/pdf-to-images/webp-encode.ts` (NEW) — `probeWebpEncode` (canvas-injected
  capability probe), `verifyWebpBlob` (authoritative MIME check),
  `WEBP_UNSUPPORTED_CODE = "webpOut.errorUnsupported"`.
- `tools/pdf-to-images/worker.ts` (EDITED — sanctioned family pattern, least
  duplication) — now serves pdf-to-jpg/pdf-to-png/pdf-to-webp; webp gets an
  up-front capability probe + per-blob MIME verification; jpg/png behaviour
  unchanged (smoke regression vectors).
  ⚠ Sibling note: if your tool also extends this worker, the diff to merge is
  small (FORMAT_SPECS entry + verifyMime blocks in `run()`).
- `tools/pdf-to-webp/config.ts` (NEW) — dpi/pages/quality select, shared worker.
- `tools/pdf-to-webp/i18n.json` (NEW) — section `webpOut`, 5 keys ×2.
- `scripts/smoke-pdf-to-webp.ts` (NEW) — **88 passed, 0 failed**.
- QA asset: `download/qa-pdf-to-webp-fixture.pdf` (real 3-page PDF).

## Verification
- `bun scripts/smoke-pdf-to-webp.ts` → 88 passed, 0 failed.
- `bun run lint` → 0 problems.
- `bunx tsc --noEmit` → 0 errors in ALL my files. The only project-wide error
  at finish time was `tools/pdf-to-markdown/worker.ts:18` (concurrent sibling
  agent's in-progress work — not mine, not touched).

## Orchestrator wiring (NOT done — outside my ownership)
1. `src/lib/tools/configs.ts`:
   `import { config as pdfToWebp } from "../../../tools/pdf-to-webp/config";`
   + `[pdfToWebp.toolId]: pdfToWebp,` after the pdfToPng entry.
2. `src/lib/tools/panels.tsx` (recommended): `"pdf-to-webp": PdfToImagesPanel,`
   (import already present).
3. NO custom surface needed — generic ToolShell (no TOOL_SURFACES entry).
4. Registry: flip existing `pdf-to-webp` def to `enabled: true`.
5. i18n merge: `tools/pdf-to-webp/i18n.json` → section **`webpOut`**
   (merge-card-i18n.ts flow; parity pre-verified).
6. chainToolIds: `["images-to-pdf", "webp-to-pdf", "heic-to-pdf", "jpg-to-pdf"]`.
7. agent-browser QA with `download/qa-pdf-to-webp-fixture.pdf` — the smoke
   cannot run pdf.js / real WebP encode under Bun (P4.1-c2 lesson, no
   OffscreenCanvas); covered honestly with pure logic + mocked canvases.

## Key decisions
- Extended the SHARED worker (family's own pattern) instead of duplicating the
  render loop; webp-specific logic lives in the two pure modules.
- WebP quality is a SELECT (0.9/0.85/0.8/0.7, default 0.85 — already 0..1),
  not jpg's percent number field.
- No `transparent` option (task spec: dpi + pages + quality; lossy sibling
  pdf-to-jpg has none either). The worker's format.alpha=true means adding the
  switch later is a one-field config change if ever wanted.
- Older-Safari silent PNG fallback → honest error `webpOut.errorUnsupported`
  with observed MIME as `{detail}`, detected BOTH up-front (fast fail) and
  per-blob (authoritative).
