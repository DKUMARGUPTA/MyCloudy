/**
 * PRE-BUILD smoke for PHASE-6 Workflow Builder. Pure logic (lib.ts) —
 * the runner/worker glue is browser-E2E covered (surface run path).
 *
 *  1. Registry: workflow-builder entry enabled + correct shape.
 *  2. Configs: TOOL_CONFIGS registration, noFile, howKeys.
 *  3. Surfaces: TOOL_SURFACES registration.
 *  4. Library: chainable filter (includes acceptance trio, excludes
 *     page-grid family / viewers / image-output / AI / builder itself).
 *  5. Presets: toolIds valid + in library, override keys exist in schema.
 *  6. Steps: makeStep defaults from schema.
 *  7. validateWorkflowDoc: accept valid, reject corrupt (bad version,
 *     unknown tool, non-scalar options, >MAX_STEPS), drop stale ids.
 *  8. JSON round-trip: export text → parse → identical.
 *  9. i18n: wf.* parity en = hi + every referenced key exists.
 * 10. Registry count: 137 live / 140 total.
 *
 * Run: bun scripts/smoke-workflow.ts
 */
import { readFileSync } from "node:fs";

import {
  ALL_TOOLS,
  getTool,
  liveToolCount,
} from "../src/lib/tools/registry";
const LIVE_COUNT = liveToolCount;
import { TOOL_CONFIGS } from "../src/lib/tools/configs";
import { defaultOptionValues } from "../src/lib/tools/config-types";
import { TOOL_SURFACES } from "../src/lib/tools/surfaces";
import {
  MAX_STEPS,
  WORKFLOW_PRESETS,
  buildWorkflowLibrary,
  groupLibraryByCategory,
  makeStep,
  makeWorkflow,
  parseWorkflowExport,
  presetToDoc,
  validateWorkflowDoc,
  workflowToJson,
} from "../tools/workflow-builder/lib";

let pass = 0;
let fail = 0;

function check(ok: boolean, label: string, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("1) Registry entry");
{
  const tool = getTool("workflow-builder");
  check(tool !== undefined, "getTool('workflow-builder') resolves");
  if (tool) {
    check(tool.enabled === true, "enabled");
    check(tool.category === "organize", "category organize");
    check(tool.accepts === "pdf", "accepts pdf");
    check(tool.mode === "D", "device mode");
    check(tool.name.en.length > 0 && tool.name.hi.length > 0, "name EN+HI");
  }
}

console.log("2) Config registration");
{
  const config = TOOL_CONFIGS["workflow-builder"];
  check(config !== undefined, "TOOL_CONFIGS has workflow-builder");
  if (config) {
    check(config.toolId === "workflow-builder", "toolId");
    check(config.noFile === true, "noFile (surface-is-product)");
    check(config.options.length === 0, "no schema options (custom surface)");
    check(
      Array.isArray(config.howKeys) && config.howKeys.length === 3,
      "howKeys ×3"
    );
    check(config.features.length >= 4, "features ≥4");
    check(config.faq.length >= 3, "faq ≥3");
  }
}

console.log("3) Surface registration");
{
  check(
    TOOL_SURFACES["workflow-builder"] !== undefined,
    "TOOL_SURFACES has workflow-builder"
  );
}

console.log("4) Chainable library");
const library = buildWorkflowLibrary();
{
  check(library.length >= 60, `library size ≥60 (got ${library.length})`);
  const ids = new Set(library.map((item) => item.tool.id));
  // Acceptance pipeline trio must be chainable.
  check(ids.has("compress-pdf"), "includes compress-pdf");
  check(ids.has("add-watermark"), "includes add-watermark");
  check(ids.has("add-page-numbers"), "includes add-page-numbers");
  // Preset extras.
  check(ids.has("pdf-to-greyscale"), "includes pdf-to-greyscale");
  check(ids.has("scanner-effect"), "includes scanner-effect");
  check(ids.has("change-pdf-doc-info"), "includes change-pdf-doc-info");
  // Excluded: builder itself.
  check(!ids.has("workflow-builder"), "excludes workflow-builder itself");
  // Excluded: page-grid family (fileIds-in-options).
  for (const id of [
    "multi-tool-pdf",
    "rotate-pdf-pages",
    "rearrange-pdf-pages",
    "remove-pdf-pages",
    "extract-pdf-pages",
  ]) {
    check(!ids.has(id), `excludes page-grid ${id}`);
  }
  // Excluded: viewer / no-file / non-PDF-output tools.
  check(!ids.has("view-pdf"), "excludes viewer view-pdf");
  check(!ids.has("generate-password"), "excludes noFile generate-password");
  check(!ids.has("pdf-to-jpg"), "excludes image-output pdf-to-jpg");
  check(!ids.has("pdf-to-zip"), "excludes zip-output pdf-to-zip");
  check(!ids.has("chat-with-pdf"), "excludes deferred AI chat-with-pdf");
  // Every library entry: enabled + worker + pdf out + pdf/any in.
  check(
    library.every(
      (item) =>
        item.tool.enabled &&
        item.config.createWorker !== undefined &&
        item.config.outputKind === "pdf" &&
        (item.tool.accepts === "pdf" || item.tool.accepts === "any")
    ),
    "every entry: enabled + createWorker + outputKind pdf + accepts pdf/any"
  );
  const groups = groupLibraryByCategory(library);
  check(groups.length >= 6, `grouped by ≥6 categories (got ${groups.length})`);
  check(
    groups.every((group) => group.tools.length > 0),
    "no empty groups"
  );
}

console.log("5) Presets");
{
  check(WORKFLOW_PRESETS.length === 3, "3 presets shipped");
  const ids = new Set(library.map((item) => item.tool.id));
  for (const preset of WORKFLOW_PRESETS) {
    check(preset.toolIds.length >= 2, `preset ${preset.key} has ≥2 steps`);
    check(
      preset.toolIds.every((id) => ids.has(id)),
      `preset ${preset.key} toolIds all chainable`
    );
    if (preset.overrides) {
      for (const [toolId, values] of Object.entries(preset.overrides)) {
        const item = library.find((entry) => entry.tool.id === toolId);
        const fieldIds = new Set(
          item ? item.config.options.map((field) => field.id) : []
        );
        check(
          Object.keys(values).every((key) => fieldIds.has(key)),
          `preset ${preset.key} override keys valid for ${toolId}`
        );
      }
    }
  }
  const emailReady = presetToDoc(WORKFLOW_PRESETS[0]);
  check(
    emailReady.steps.map((step) => step.toolId).join(",") ===
      "compress-pdf,add-watermark,add-page-numbers",
    "emailReady = compress → watermark → page-numbers"
  );
}

console.log("6) Step defaults");
{
  const step = makeStep("compress-pdf");
  check(step.toolId === "compress-pdf", "makeStep toolId");
  check(typeof step.id === "string" && step.id.length > 0, "makeStep id");
  const expected = defaultOptionValues(
    TOOL_CONFIGS["compress-pdf"].options
  );
  check(
    JSON.stringify(step.options) === JSON.stringify(expected),
    "options = schema defaults"
  );
  const noSchema = makeStep("add-watermark");
  check(
    Object.keys(noSchema.options).length === 0,
    "empty-schema tool → empty options"
  );
}

console.log("7) validateWorkflowDoc");
{
  const libraryIds = new Set(library.map((item) => item.tool.id));
  const good = makeWorkflow("Test", [
    makeStep("compress-pdf"),
    makeStep("add-watermark"),
  ]);
  const valid = validateWorkflowDoc(good, library);
  check(valid !== null, "valid doc accepted");
  check(
    valid !== null && valid.steps.length === 2 && valid.name === "Test",
    "valid doc round-shape"
  );
  check(
    valid !== null &&
      valid.steps.every((step) => libraryIds.has(step.toolId)),
    "valid doc steps preserved"
  );

  check(validateWorkflowDoc(null, library) === null, "null rejected");
  check(
    validateWorkflowDoc({ version: 2 }, library) === null,
    "wrong version rejected"
  );
  check(
    validateWorkflowDoc({ ...good, steps: [{ id: "x", toolId: "nope", options: {} }] }, library) === null,
    "unknown toolId rejected"
  );
  check(
    validateWorkflowDoc(
      { ...good, steps: Array.from({ length: MAX_STEPS + 1 }, () => makeStep("compress-pdf")) },
      library
    ) === null,
    `> MAX_STEPS (${MAX_STEPS}) rejected`
  );
  check(
    validateWorkflowDoc({ ...good, name: 42 }, library) === null,
    "non-string name rejected"
  );
  // Non-scalar option values are dropped, schema-known scalars survive.
  const dirty = makeWorkflow("dirty", [
    {
      id: "s1",
      toolId: "compress-pdf",
      options: {
        preset: "strong",
        quality: "50",
        __proto__: undefined,
      } as Record<string, string | number | boolean>,
    },
  ]);
  const cleaned = validateWorkflowDoc(dirty, library);
  check(
    cleaned !== null && cleaned.steps[0].options.preset === "strong",
    "known scalar option kept"
  );
  // Stale (unknown) option ids are dropped.
  const stale = makeWorkflow("stale", [
    { id: "s1", toolId: "add-watermark", options: { ghost: 1 } },
  ]);
  const cleanedStale = validateWorkflowDoc(stale, library);
  check(
    cleanedStale !== null &&
      Object.keys(cleanedStale.steps[0].options).length === 0,
    "stale option ids dropped"
  );
}

console.log("8) JSON round-trip");
{
  const doc = presetToDoc(WORKFLOW_PRESETS[1]);
  doc.name = "Scan cleanup v2";
  const json = workflowToJson(doc);
  const parsed = parseWorkflowExport(json, library);
  check(parsed !== null, "export parses back");
  check(
    parsed !== null &&
      parsed.name === doc.name &&
      parsed.steps.length === doc.steps.length &&
      parsed.steps.every(
        (step, index) =>
          step.toolId === doc.steps[index].toolId &&
          JSON.stringify(step.options) ===
            JSON.stringify(doc.steps[index].options)
      ),
    "steps + options identical after round-trip"
  );
  check(
    parseWorkflowExport("{not json", library) === null,
    "garbage text rejected"
  );
  check(
    parseWorkflowExport(JSON.stringify({ hello: 1 }), library) === null,
    "non-workflow JSON rejected"
  );
}

console.log("9) i18n wf.* parity");
{
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  const leafKeys = (obj: Record<string, unknown>, prefix = ""): string[] => {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "object" && v !== null) {
        out.push(...leafKeys(v as Record<string, unknown>, key));
      } else {
        out.push(key);
      }
    }
    return out.sort();
  };
  const enKeys = leafKeys(en);
  const hiKeys = leafKeys(hi);
  check(enKeys.length === hiKeys.length, `catalog parity ${enKeys.length} = ${hiKeys.length}`);
  const enWf = enKeys.filter((key) => key.startsWith("wf."));
  const hiWf = hiKeys.filter((key) => key.startsWith("wf."));
  check(enWf.length >= 55, `wf.* keys ≥55 (got ${enWf.length})`);
  check(
    JSON.stringify(enWf) === JSON.stringify(hiWf),
    "wf.* key sets identical en/hi"
  );
  // Every key the surface/config references must exist.
  const required = [
    "wf.how1", "wf.how2", "wf.how3",
    "wf.unnamed", "wf.namePlaceholder", "wf.nameLabel",
    "wf.stepCount", "wf.presets", "wf.saveAction",
    "wf.preset.emailReady", "wf.preset.scanClean", "wf.preset.archivePrep",
    "wf.saved", "wf.noSaved", "wf.load", "wf.delete",
    "wf.export", "wf.import",
    "wf.importFailedTitle", "wf.importFailedDesc", "wf.importedToast",
    "wf.presetLoadedToast", "wf.savedToast", "wf.deletedToast",
    "wf.inputTitle", "wf.inputLabel", "wf.removeInput",
    "wf.stepsTitle", "wf.emptySteps", "wf.addStep", "wf.maxSteps",
    "wf.settingsChanged", "wf.outputsCount", "wf.noOptions",
    "wf.moveUp", "wf.moveDown", "wf.remove",
    "wf.stepRunning", "wf.stepDone", "wf.stepError", "wf.stepCancelled",
    "wf.outputTitle", "wf.outputReady",
    "wf.stepFailed", "wf.partialHint", "wf.partialTitle", "wf.resultTitle",
    "wf.download", "wf.downloadAll",
    "wf.runningTitle", "wf.cancel", "wf.run",
    "wf.runNeedsInput", "wf.runNeedsSteps", "wf.runHint",
    "wf.runDoneToast", "wf.runCancelledToast", "wf.editPipeline",
    "wf.pickerTitle", "wf.pickerDesc", "wf.searchTools", "wf.noToolsFound",
  ];
  const enSet = new Set(enKeys);
  const missing = required.filter((key) => !enSet.has(key));
  check(missing.length === 0, `all referenced keys present (missing: ${missing.join(", ") || "none"})`);
}

console.log("10) Registry counts");
{
  const total = ALL_TOOLS.length;
  check(LIVE_COUNT === 141, `live tool count 141 (got ${LIVE_COUNT})`);
  check(total === 140, `total tool count 140 (got ${total})`);
}

console.log(`\n${"=".repeat(50)}`);
if (fail === 0) {
  console.log(`✓ ALL ${pass} PASS — workflow builder logic green`);
} else {
  console.error(`✗ ${fail} FAILED (of ${pass + fail})`);
  process.exit(1);
}
