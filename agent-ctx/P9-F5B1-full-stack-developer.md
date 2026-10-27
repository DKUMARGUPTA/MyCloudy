# Task P9-F5B1 — create-electronic-invoice (91st tool) + shared EInvoiceForm

Full detail lives in `/home/z/my-project/worklog.md` (P9-F5B-EINVOICE entry).
Sibling record: `P9-F5B2-full-stack-developer.md` (pdf-to-e-invoice).

## What was built (files + line counts)

| File | Lines | Notes |
|---|---|---|
| `src/lib/pdf/thumbnails.ts` | +42 | NEW exported `getPdfAllPagesText(file, maxPages=10): Promise<string[]>` — reads ALL pages, per-page extraction identical to `getPdfPageTextPreview` (str items joined, hasEOL → "\n", `\n{3,}`→`\n\n`, trailing-space + trim cleanup, `page.cleanup()` in finally). Uses the file-internal `openDocument` cache. |
| `tools/einvoice-common/payload.ts` | 201 | NEW pure module (bun-testable, no DOM/React): `EINV_MAX_ITEMS=25`, `EINV_PROFILES`/`normalizeProfile`, `gstStateOf` (GSTIN prefix → GST state code), `emptyEInvoiceForm` (today, due+15, GST 18, 1 row), `sampleEInvoiceState` (Sharma Traders fixture), `buildInvOption`/`parseInvOption` (the `{ s }` JSON contract), `mergeExtracted(current, ex)` (prefill merge, notes-gated), `serializeDraft`/`parseDraft` (tamper-safe). |
| `tools/einvoice-common/eiform.tsx` | 634 | NEW shared `EInvoiceForm({ state, setState, notes })`: business/client/invoice/items/discount/round-off/advance sections, live summary strip via `calc()` (sub/tax/tot + disc/adv/bal when non-zero), amber GSTIN checksum hint via `gstOK()` (shown at ≥15 chars + failing), GSTIN inputs uppercase+despace+15-cap and silently derive biz.state / cli.state+pos so the CGST+SGST vs IGST split is right, items editor with add/remove (cap 25, last row clears), mobile stacking (one field per row, `min-w-0` everywhere), every label `t("einv.*")`. Controlled inputs — event handlers only. |
| `tools/create-electronic-invoice/worker.ts` | 6 | Sibling re-export of `../einvoice-common/worker` (turbopack-safe `./worker.ts` URL pattern). |
| `tools/create-electronic-invoice/config.ts` | 81 | toolId `create-electronic-invoice`, `createWorker → ./worker.ts`, outputKind "pdf", minFiles 1 / maxFiles 1, `howKeys einv.how1-3`, chainToolIds view-pdf + validate-e-invoice, `options: []` (surface drives them), 5 bilingual features + 3 bilingual FAQ (honest core-subset scope). |
| `tools/create-electronic-invoice/surface.tsx` | 289 | `ElectronicInvoiceSurface(props: ToolSurfaceProps)` — REGULAR file tool surface (shell owns DropZone + sticky CTA; surface owns the main column once the PDF is in): (a) PDF status card (name+size+kept-as-is hint+Original badge), (b) profile select Factur-X 1.0 ↔ XRechnung 3.0, (c) EInvoiceForm, (d) run-summary card (both outputs + runHint). Options set: **"inv"** = `JSON.stringify({ s })` (debounced 250ms) and **"profile"** = "facturx"\|"xrechnung" (event-context). `setRunBlocked(files.length === 0 \|\| !state.biz.name ? "einv.needFile" : null)` via effect. localStorage draft `dp_einv` (debounced save, restore banner on fresh visits only — phase remounts prefer the live option), Load sample button. |
| `tools/create-electronic-invoice/i18n.json` | 162 | `{ en: { einv, p2e }, hi: { einv, p2e } }` — shared for BOTH tools. |
| `scripts/merge-einvoice-i18n.ts` | 117 | passport-pattern merge: inserts BOTH sections, part parity, clobber refusal, required-keys contract (how1-3 ×2 + needFile), source-literal cross-check (eiform + both surfaces), whole-catalog leaf parity, rewrite. |
| `scripts/smoke-p9-f5b.ts` | 211 | 40 checks / 40 passed (see below). |

## QA (all green)
- `bun scripts/merge-einvoice-i18n.ts` → OK; re-run correctly REFUSES (clobber guard). Final catalog **3067 = 3067** (was 2993; +61 einv +13 p2e leaves).
- `bunx tsc --noEmit` → 0 errors (includes the new thumbnails.ts helper).
- `bun run lint` → 0 problems. One `react-hooks/set-state-in-effect` was caught and fixed en route (p2e `!file` reset moved behind a microtask helper).
- `bun scripts/smoke-p9-f5b.ts` → **40 passed, 0 failed**.
- dev.log clean (fast-reload expected after the i18n rewrite).

## Contract notes for the orchestrator
- Registry mode for `create-electronic-invoice` currently says "S" but the tool is 100% on-device (client worker) — flip to "D" when wiring, like validate-pdfa was.
- Surface export names to register in `TOOL_SURFACES`: `ElectronicInvoiceSurface` (create-electronic-invoice), `PdfToEInvoiceSurface` (pdf-to-e-invoice).
- The shared worker returns TWO outputs per run (e-invoice PDF + factur-x.xml); detail `{files: 2, pages, annotations}`.
- `getPdfAllPagesText` is browser-only (pdf.js) — browser E2E is the orchestrator's job, as specified.
