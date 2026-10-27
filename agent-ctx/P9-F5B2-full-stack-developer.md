# Task P9-F5B2 — pdf-to-e-invoice (92nd tool)

Full detail lives in `/home/z/my-project/worklog.md` (P9-F5B-EINVOICE entry).
Sibling record: `P9-F5B1-full-stack-developer.md` (create-electronic-invoice + the shared EInvoiceForm + payload helpers this tool reuses).

## What was built (files + line counts)

| File | Lines | Notes |
|---|---|---|
| `tools/pdf-to-e-invoice/worker.ts` | 6 | Sibling re-export of `../einvoice-common/worker` (identical run: attach Factur-X CII XML → e-invoice PDF + standalone XML). |
| `tools/pdf-to-e-invoice/config.ts` | 80 | toolId `pdf-to-e-invoice`, `createWorker → ./worker.ts`, outputKind "pdf", minFiles 1 / maxFiles 1, `howKeys p2e.how1-3`, chainToolIds create-electronic-invoice + validate-e-invoice, `options: []`, 5 bilingual features (prefill + verify + attach + both outputs + on-device) + 3 bilingual FAQ (extraction quality + scanned→OCR honesty, pixel-identical promise, legal-document review). |
| `tools/pdf-to-e-invoice/surface.tsx` | 479 | `PdfToEInvoiceSurface(props: ToolSurfaceProps)` — tool 1's architecture PLUS the extraction step. |

## The extraction step (the part unique to this tool)
- File is DERIVED from props (`files[0]?.file ?? null`), never copied into state; `useEffect` on the file identity fires `readFile(file, apply)` with an async promise (microtask first — the search-pdf rule, no sync setState in effect bodies).
- `readFile` calls the NEW `getPdfAllPagesText(file, 10)` (added to `src/lib/pdf/thumbnails.ts`, exact `getPdfPageTextPreview` per-page recipe for every page), then `extractInvoiceFields(pages)`.
- Status machine: `idle → reading → done | notext | error` with a stale-read token (cancelled reads can never write back).
- `done` + notes → **"Found on the PDF" chips** (field label localized via a `CHIP_KEYS` map — "Seller GSTIN"→`einv.bizGstin` etc. — plus the found value) and the form is prefilled via `mergeExtracted` (pure, in `tools/einvoice-common/payload.ts`; only fields with an actual extraction NOTE are taken, manual edits survive).
- `done` + no notes → honest **"Nothing recognised"** empty state; the form stays fully usable.
- All pages empty → **scanned-PDF note** ("run OCR PDF first"); read failure → honest readError note.
- **"Re-read from PDF" button** always re-runs WITH the merge applied (explicit user intent).
- Prefill-clobber guard: the merge auto-applies exactly ONCE per `File` object (module-level `PREFILLED_FILES` WeakSet) — a phase remount that restores the edited form from the `inv` option never gets its corrections overwritten, while a genuinely new PDF still prefills.
- Rest identical to tool 1: PDF status card, profile select, EInvoiceForm (the verify reminder rides in the form's `notes` while chips exist), run summary, localStorage draft `dp_p2e` + restore banner, Load sample. Same option keys: **"inv"** + **"profile"**.

## QA
- `bunx tsc --noEmit` 0 errors · `bun run lint` 0 problems · `bun scripts/smoke-p9-f5b.ts` **40/40** (prefill-merge section proves the 2-page fake text → GSTINs + states + pos, buyer name, invoice no, ISO date, parked grand-total row, 9+9→18 rate hint, manual-field preservation, no-hint tr retention, scanned empty-result).
- i18n `p2e` namespace 13 keys ×2 (en=hi), catalog 3067 = 3067.
- Browser E2E (real pdf.js read + chips + run) is the orchestrator's job per the task spec.
