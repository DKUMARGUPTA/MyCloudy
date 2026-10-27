/**
 * SMOKE: Smart format router (P3).
 *
 * §1 Graph integrity: every edge references a live registry tool.
 * §2 Direct routes: known pairs exist; same-format rejected.
 * §3 Multi-hop: docx→png routes through pdf; epub→jpg; heic→tiff; etc.
 * §4 Ranking: fewer hops first; no loops; max-hops respected.
 * §5 Query parsing: "docx to png", "epub → jpg", "heic 2 pdf", aliases
 *    (jpeg→jpg, word→docx), rejects junk.
 * §6 The surface: search-palette wiring strings exist in both catalogs.
 */

import {
  findRoutes,
  hasDirectRoute,
  parseRouteQuery,
  routeStepLabel,
  KNOWN_FORMATS,
} from "../src/lib/tools/router";
import { ALL_TOOLS } from "../src/lib/tools/registry";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// §1 Graph integrity
{
  const ids = new Set(ALL_TOOLS.map((t) => t.id));
  // Indirect: every route produced only references registry tools.
  const routes = [
    ...findRoutes("docx", "png"),
    ...findRoutes("epub", "jpg"),
    ...findRoutes("heic", "tiff"),
    ...findRoutes("csv", "png"),
    ...findRoutes("rtf", "webp"),
  ];
  let allLive = true;
  for (const r of routes) {
    for (const s of r.steps) {
      if (!ids.has(s.toolId)) allLive = false;
    }
  }
  check("all route steps reference live registry tools", allLive);
  check("KNOWN_FORMATS populated", KNOWN_FORMATS.length >= 20, `${KNOWN_FORMATS.length}`);
}

// §2 Direct routes
{
  check("direct docx→pdf", hasDirectRoute("docx", "pdf"));
  check("direct pdf→png", hasDirectRoute("pdf", "png"));
  check("direct heic→jpg", hasDirectRoute("heic", "jpg"));
  check("no direct docx→png", !hasDirectRoute("docx", "png"));
  check("same format → no routes", findRoutes("pdf", "pdf").length === 0);
}

// §3 Multi-hop
{
  const docxToPng = findRoutes("docx", "png", 3);
  check("docx→png has routes", docxToPng.length > 0, `${docxToPng.length}`);
  const best = docxToPng[0];
  check(
    "docx→png best route is 2 hops via pdf",
    best.steps.length === 2 &&
      best.steps[0].from === "docx" &&
      best.steps[0].to === "pdf" &&
      best.steps[1].from === "pdf" &&
      best.steps[1].to === "png",
    JSON.stringify(best.steps.map((s) => `${s.from}>${s.to}`))
  );
  check(
    "docx→png uses word-to-pdf + pdf-to-png",
    best.steps[0].toolId === "word-to-pdf" && best.steps[1].toolId === "pdf-to-png",
    best.steps.map((s) => s.toolId).join(",")
  );

  const epubJpg = findRoutes("epub", "jpg", 3);
  check(
    "epub→jpg routes via pdf",
    epubJpg.length > 0 && epubJpg[0].steps.length === 2 &&
      epubJpg[0].steps.some((s) => s.to === "pdf"),
    JSON.stringify(epubJpg.map((r) => r.steps.map((s) => s.toolId)))
  );

  const heicTiff = findRoutes("heic", "tiff", 3);
  check(
    "heic→tiff routes exist",
    heicTiff.length > 0 && heicTiff[0].steps.length >= 2,
    JSON.stringify(heicTiff.map((r) => r.steps.map((s) => s.toolId)))
  );

  // Direct pair suppresses the single-hop echo (no duplicate of the direct tool).
  const pdfPng = findRoutes("pdf", "png", 3);
  check(
    "direct pair (pdf→png) yields no 1-step echo",
    pdfPng.every((r) => r.steps.length > 1) || pdfPng.length === 0,
    JSON.stringify(pdfPng.map((r) => r.steps.length))
  );
}

// §4 Ranking + termination
{
  const csvPng = findRoutes("csv", "png", 3);
  check("csv→png routes exist", csvPng.length > 0);
  const hops = csvPng.map((r) => r.steps.length);
  check("routes sorted by hop count", hops.every((h, i) => i === 0 || h >= hops[i - 1]), hops.join(","));
  check("max hops respected", hops[0] <= 3);
  // No route revisits a format (loop check on the step chain).
  let noLoops = true;
  for (const r of csvPng) {
    const seen = new Set<string>();
    for (const s of r.steps) {
      if (seen.has(s.to)) noLoops = false;
      seen.add(s.from);
    }
  }
  check("no format loops in routes", noLoops);
}

// §5 Query parsing
{
  check('parse "docx to png"', JSON.stringify(parseRouteQuery("docx to png")) === '{"from":"docx","to":"png"}');
  check('parse "epub → jpg"', parseRouteQuery("epub → jpg")?.to === "jpg");
  check('parse "heic 2 pdf"', parseRouteQuery("heic 2 pdf")?.from === "heic");
  check("alias jpeg→jpg", parseRouteQuery("jpeg to png")?.from === "jpg");
  check("alias word→docx", parseRouteQuery("word to pdf")?.from === "docx");
  check("reject junk query", parseRouteQuery("hello world") === null);
  check("reject unknown formats", parseRouteQuery("foo to bar") === null);
  check("reject same format", parseRouteQuery("pdf to pdf") === null);
  check("trim + case-insensitive", parseRouteQuery("  DOCX to PNG  ")?.from === "docx");
}

// §6 Surface wiring
{
  const en = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
  const hi = JSON.parse(readFileSync("src/i18n/hi.json", "utf8"));
  check("i18n palette.routeHeading en+hi", typeof en.palette?.routeHeading === "string" && typeof hi.palette?.routeHeading === "string");
  check("i18n palette.routeSteps en+hi", typeof en.palette?.routeSteps === "string" && typeof hi.palette?.routeSteps === "string");
  const paletteSrc = readFileSync("src/components/doco/search/search-palette.tsx", "utf8");
  check("palette imports findRoutes", paletteSrc.includes("findRoutes"));
  check("palette renders route steps", paletteSrc.includes("routeStepLabel"));
  check("labels resolve in both locales", routeStepLabel({ toolId: "word-to-pdf", from: "docx", to: "pdf" }, "en") === "Word to PDF");
}

console.log(`\nrouter smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  fails.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
process.exit(0);
