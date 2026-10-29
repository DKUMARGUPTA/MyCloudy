# P6-o-a — annotate-pdf + make-pdf-fillable onto the OWN engine

Round P6-o slice A. Ported the two EDIT-SURFACE-family tools off pdf-lib
onto `src/lib/own/pdf` (StampContext), ZERO behavioral change, all smokes
at HEAD counts. Slice B (edit-pdf) untouched, per the split.

## Smoke results (final, all green)

| script | HEAD (before my edits) | after | gate |
|---|---|---|---|
| `scripts/smoke-annotate-pdf.ts` | 92 passed / 0 failed | **92 / 0** | ✅ identical |
| `scripts/smoke-make-fillable.ts` | 68/68 GREEN | **68/68 GREEN** | ✅ identical |
| `scripts/smoke-pdf-core.ts` | 622 passed / 0 failed | **622 / 0** | ✅ unchanged |
| `npx tsc --noEmit \| wc -l` | 380 | **380** | ✅ baseline, no error mentions my files |
| eslint on the 5 gate files | — | **0 problems** | ✅ |
| `rg 'from "pdf-lib"' tools/annotate-pdf/ tools/make-pdf-fillable/` | (tools were on pdf-lib) | **ZERO hits** | ✅ |

NOTE on counts: the task brief said "annotate ~57, make-fillable ~76" and
"pdf-core 623/623" — the ACTUAL HEAD counts in this tree are 92, 68 and
622. I captured them before touching anything (the working tree had only
main's P6-o engine work; both tools were still pdf-lib at that point) and
reproduced them exactly. pdf-core prints `622 passed, 0 failed` (622 `ok`
lines, 0 `not ok`) both before and after my engine edit — no regression.

## Files changed

1. **`tools/annotate-pdf/worker.ts`** — full port. `PDFDocument.load(...,
   {ignoreEncryption:true})` + `page.node.addAnnot(context.register(obj(dict)))`
   → `StampContext.load(bytes)` + `ctx.appendAnnot(p, dict)` + `ctx.write()`.
   - Load-error mapping preserved: PdfError code "encrypted" →
     `throw new Error("PDF_PASSWORD")` (the parity of the old
     ignoreEncryption + isEncrypted refusal); everything else →
     `"PDF_PARSE"`. The onmessage mapping (tool.errorEncrypted /
     tool.errorCorrupt / ann.errorBuild) is untouched and unchanged.
   - `page.getCropBox()` → `ctx.pages[p].cropBox` ([x0,y0,x1,y1] →
     {x,y,width,height}). Engine parity: cropBox defaults to MediaBox,
     MediaBox to Letter [0,0,612,792] — the same default the old
     try/catch fell back to.
   - Annotation dicts rebuilt as OUR PdfObj: strings → `name()`,
     numbers → `num()`, arrays → `arr()/numArr()`, nested /BS → `newDict`,
     `PDFHexString.fromText` → `hstr(utf16be(s))` (UTF-16BE + FEFF BOM —
     byte-identical to pdf-lib's form), `PDFString.of(date)` →
     `lstr(latin1Bytes(date))` (literal parenthesized string — pdf-lib's
     form). Key order preserved (Map insertion order == the old object
     literal order).
   - Progress posts, output name, result detail (markups/notes/pages)
     byte-identical. pdf-lib import deleted.

2. **`tools/make-pdf-fillable/engine.ts`** — builder port.
   - `buildFieldPdf`: StampContext.load → per-spec
     `ctx.createCheckBox(name).addToSlot(page, {...borderWidth:1,
     borderColor:{.45,.49,.55}})` / `ctx.createTextField(name)`
     (+`enableMultiline`) `.addToSlot(page, {...})` → `ctx.write()`.
     uniqueName dedupe kept byte-identical, seeded by a NEW walker
     (below). The page guard now checks
     `Number.isInteger(spec.page) && 0 <= page < ctx.pageCount` — the
     parity of the old `pages[spec.page]` undefined-skip (fractional/
     negative pages skip silently instead of hitting the engine's typed
     range error).
   - **taken-names walker** (`existingFieldNames`): catalog /AcroForm →
     /Fields (indirect /Fields and /Kids resolved via engine
     `resolve()`), every field's /T decoded UTF-16BE-with-BOM else
     latin1 (the engine's `decodePdfText` pattern copied locally),
     pdf-lib's getFields shape: non-terminal = /Kids containing kids
     WITH /T (pdf-lib's exact classification from
     core/acroform/utils.js) → recurse with FQN assembly
     ("parent.child"); terminals collected. No /AcroForm → empty set.
   - `countExistingFields`: parsePdf + the same walk counting terminals
     (pdf-lib getFields().length shape; identical to /Fields length for
     flat forms). parsePdf stays OUTSIDE the try (pdf-lib's load was
     outside it too — corrupt/encrypted inputs reject, only a broken
     AcroForm walk yields 0).
   - **Error routing parity for the UNCHANGED worker's regexes**: the
     old pdf-lib load failures said "Failed to parse …" (→
     tool.errorCorrupt) and "…is encrypted…" (→ makeFillable.errorBuild
     — pdf-lib's message never matched /password/ either; verified live
     against node_modules). Port: non-encrypted load failures rethrow as
     `Failed to parse PDF document: <engine message>` (same code);
     encrypted keeps our "document is encrypted — unlock it first"
     (same code, only the raw detail string differs).
   - ALL pure geometry/transform helpers byte-identical
     (mergeLineSegments, classifyRect, lineToSpecRect, labelForRect,
     uniqueName, displaySize, pdfToDisplayPoint, displayToPdfPoint,
     pdfRectToDisplay, displayRectToPdf, sanitizeSpecs + constants).
   - Deleted the `export { PDFCheckBox, PDFTextField }` pdf-lib
     re-export — repo-wide grep confirmed ZERO importers (smoke-fill.ts
     and smoke-create-fillable-pdf-form.ts import them straight from
     "pdf-lib").

3. **`tools/make-pdf-fillable/worker.ts`** — code byte-identical (it only
   calls buildFieldPdf/sanitizeSpecs; parseSpecs/parseBlob untouched);
   ONE doc-comment line updated to stop claiming the pipeline is
   "pdf-lib AcroForm" (now "OWN-engine AcroForm (StampContext, P6-o-a)").

4. **`src/lib/own/pdf/stamp.ts`** — ENGINE GAP FIX (see below). ~40 lines
   in `newFormField` + a `sourceAcroForm()` helper.

5. **Smokes: NO EDITS NEEDED.** Both scripts already use pdf-lib purely
   as the reload-ORACLE (the established pattern); the tools' postMessage
   protocol and output object contracts are identical, so Part 1/2/3
   passed unmodified on the first run after the port. Zero assertions
   weakened, zero encoding-agnostic rewrites required — the engine's
   hstr/lstr encodings are already the pdf-lib byte forms.

## The engine gap I found and FIXED (not hacked around)

**Repro (before the fix):** build fields on a doc that ALREADY has an
/AcroForm — e.g. run make-pdf-fillable twice on the same file:

```ts
const b1 = StampContext.load(fresh).createTextField("A")… .write();
const b2 = StampContext.load(b1).createTextField("B")… .write();
// b2's /AcroForm had ONLY "B" — the 3 (n) existing fields were DROPPED
// from the catalog (their widget /Parent refs serialized as null).
```

**Root cause:** `StampContext.newFormField` created a BRAND-NEW AcroForm
dict with an EMPTY /Fields array, and `write()` replaces the catalog
/AcroForm entry wholesale — pdf-lib instead MUTATES the existing /AcroForm
(`acroForm.addField` pushes into the EXISTING /Fields array), so building
on a form-bearing doc preserved all prior fields. §22 only verified the
builder on AcroForm-free fixtures, so this was never caught. The
smoke-make-fillable assertion "dedupe: 6 fields, no name clash" pins
exactly this path.

**Fix (stamp.ts, P6-o-a comment):** on first field creation, look up the
SOURCE catalog /AcroForm (`sourceAcroForm()` — Root → AcroForm → resolve,
dict-or-stream); when found, clone its entries (minus /Fields), seed the
new /Fields with the source's items (indirect /Fields resolved), and push
the AcroForm as a **source-anchored synthetic** (`{sourceDoc, obj}`) so
the old field refs ride the writer's reachable-graph renumber — without
the anchor the old field dicts would be unreachable and dropped, and a
plain synthetic's source refs would serialize through the identity
mapRef as garbage. Docs WITHOUT a source /AcroForm take the exact old
path → byte-identical output (pdf-core §22 still 622/622). Widgets' /Parent
back-refs now resolve because their field dicts are BFS-reached via the
anchored AcroForm.

## Known, accepted deltas (family-consistent, smoke-invisible)

- Output is classic-xref/uncompressed (the engine's honest scope) vs
  pdf-lib's `useObjectStreams: true` — same story as every P6-f…P6-n
  port; readers/oracles load both identically.
- Loaded-doc /Info is not carried into the output trailer (writer scope
  since P6-f; no smoke asserts it; the whole stamp/organize family
  behaves this way).
- make-fillable's errorBuild DETAIL text on encrypted input differs in
  wording (same i18n code path — both the old and new messages route to
  makeFillable.errorBuild; only the dev-visible string changed).

## Neighbors verified (engine edit blast radius)

StampContext consumers that never build forms can't reach the changed
branch; spot-ran anyway: smoke-overlay 62/62, smoke-fill ALL GREEN,
smoke-create-fillable-pdf-form 156/156 (that tool is still pdf-lib — not
this slice). edit-pdf tools/smokes untouched (P6-o-b's slice).
