/**
 * Smoke: create-resume (CR-66) — model vectors + parser hardening +
 * REAL vector PDF renders through the worker's exact render.ts.
 *
 * Conventions (house): node:zlib inflate oracle (NOT fflate), pdf
 * reloaded + parsed for structural asserts (raw byte search is
 * unreliable inside compressed object streams), relative imports
 * without .ts, process.exit(0) at the end.
 *
 * Run: bun scripts/smoke-create-resume.ts
 */
import "regenerator-runtime/runtime";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  approxMeasure,
  atsBulletLine,
  atsContactLine,
  blankResume,
  estimatePageBreaks,
  formatDateRange,
  formatMonth,
  isWinAnsiText,
  joinMeta,
  MAX_BULLETS_PER_ITEM,
  MAX_SECTIONS,
  outputBaseName,
  parseResumeRun,
  resumeNeedsNoto,
  resumeStats,
  sampleResume,
} from "../tools/create-resume/model";
import { drawResumePdf } from "../tools/create-resume/render";
import type { ResumeDoc, ResumeRun } from "../tools/create-resume/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}: expected ${b}, got ${a}`);
    console.error(`  FAIL ${label}: expected ${b}, got ${a}`);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** All FlateDecode stream contents, inflated + latin1-decoded. */
function inflatedStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let out = "";
  let idx = 0;
  for (;;) {
    const s = raw.indexOf("stream", idx);
    if (s < 0) break;
    let start = s + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const e = raw.indexOf("endstream", start);
    if (e < 0) break;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, e), "latin1")).toString(
        "latin1"
      );
    } catch {
      /* not a flate stream (e.g. embedded font) — skip */
    }
    idx = e + 9;
  }
  return out;
}

/** True when the string appears literally OR as a pdf-lib hex string. */
function hasText(stream: string, s: string): boolean {
  if (stream.includes(s)) return true;
  const hex = Buffer.from(s, "latin1").toString("hex").toUpperCase();
  return stream.includes(hex);
}

/** Dump every indirect object (parse level — object streams defeated). */
function objDump(doc: PDFDocument): string {
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    out += `${obj.toString()}\n`;
  }
  return out;
}

const LABELS: Record<string, string> = {
  present: "Present",
  fileWord: "Resume",
  contact: "Contact",
};

const notoBytes = new Uint8Array(
  readFileSync("public/fonts/NotoSansDevanagari-Regular.ttf")
);

interface RenderOutcome {
  bytes: Uint8Array;
  reloaded: PDFDocument;
  pages: number;
  photo: boolean;
}

async function render(
  doc: ResumeDoc,
  noto: boolean
): Promise<RenderOutcome> {
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let boldFont: PDFFont | null = null;
  if (noto) {
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(notoBytes, { subset: true });
  } else {
    font = pdfDoc.embedStandardFont(StandardFonts.Helvetica);
    boldFont = pdfDoc.embedStandardFont(StandardFonts.HelveticaBold);
  }
  const run: ResumeRun = { d: doc, labels: LABELS, locale: doc.locale };
  const report = await drawResumePdf(pdfDoc, font, run, { boldFont });
  const bytes = await pdfDoc.save();
  const reloaded = await PDFDocument.load(bytes);
  return {
    bytes,
    reloaded,
    pages: reloaded.getPageCount(),
    photo: report.photo,
  };
}

/* ------------------------------------------------------------------ */
console.log("── 1. Dates ────────────────────────────────────────────");
eq(formatMonth("2021-01", "en"), "Jan 2021", "month EN");
eq(formatMonth("2021-01", "hi"), "जन 2021", "month HI");
eq(formatMonth("2021-12", "en"), "Dec 2021", "dec EN");
eq(formatMonth("2021-13", "en"), "2021", "invalid month → year");
eq(formatMonth("2021", "en"), "2021", "year only");
eq(formatMonth("2021-07-15", "en"), "Jul 2021", "day dropped");
eq(formatMonth("  2021-03  ", "en"), "Mar 2021", "trimmed");
eq(formatMonth("garbage", "en"), "garbage", "free text passthrough");

eq(
  formatDateRange("2021-01", "2023-03", false, "en", "Present"),
  "Jan 2021 – Mar 2023",
  "range EN"
);
eq(
  formatDateRange("2021-01", "", true, "en", "Present"),
  "Jan 2021 – Present",
  "current EN"
);
eq(
  formatDateRange("2021-01", "", true, "hi", "वर्तमान"),
  "जन 2021 – वर्तमान",
  "current HI"
);
eq(formatDateRange("", "2023-03", false, "en", "Present"), "", "no start");
eq(formatDateRange("", "", true, "en", "Present"), "Present", "only current");
eq(formatDateRange("2022-05", "", false, "en", "Present"), "May 2022", "one-sided");

console.log("── 2. ATS text helpers ──────────────────────────────────");
eq(
  atsContactLine({
    fullName: "x",
    headline: "x",
    email: "a@b.c",
    phone: "+91 98",
    location: "Delhi",
    linkedin: "",
    website: "w.dev",
    photo: "",
  }),
  "a@b.c · +91 98 · Delhi · w.dev",
  "contact line blanks dropped"
);
eq(atsBulletLine("Shipped X"), "• Shipped X", "bullet glyph");
eq(joinMeta(["A", "", "B", ""]), "A · B", "joinMeta");
eq(isWinAnsiText("Hello • – — €"), true, "winansi extras pass");
eq(isWinAnsiText("हिन्दी"), false, "devanagari not winansi");
eq(isWinAnsiText("cost ₹500"), false, "rupee not winansi (→ Noto)");

console.log("── 3. Stats + pagination estimate ──────────────────────");
{
  const en = sampleResume("en");
  const st = resumeStats(en);
  eq(st.sections, en.sections.length, "stats sections");
  eq(st.words > 80, true, `sample words (${st.words})`);
  eq(st.items >= 5, true, `sample items (${st.items})`);
  const est = estimatePageBreaks(en, approxMeasure, "en", "Present");
  eq(est >= 1 && est <= 3, true, `sample estimate sane (${est})`);
  eq(estimatePageBreaks(blankResume("en"), approxMeasure), 1, "blank = 1 page");

  // long doc: 25 items × 6 long bullets → many pages (same model as render)
  const long = blankResume("en");
  const exp = long.sections.find((s) => s.kind === "experience");
  if (exp && exp.kind === "experience") {
    exp.items = Array.from({ length: 25 }, (_, i) => ({
      id: `x${i}`,
      role: `Role number ${i} with a fairly long title`,
      company: `Company ${i} Private Limited`,
      location: "Bengaluru",
      start: "2018-01",
      end: "2020-12",
      current: false,
      bullets: Array.from(
        { length: 6 },
        () =>
          "Delivered a large cross-team initiative with measurable impact on revenue and reliability across several quarters of careful work and stakeholder alignment."
      ),
    }));
  }
  const longEst = estimatePageBreaks(long, approxMeasure, "en", "Present");
  eq(longEst >= 3, true, `long doc estimate ≥3 (${longEst})`);
}

console.log("── 4. Output name ───────────────────────────────────────");
eq(
  outputBaseName(
    { ...blankResume("en"), header: { ...blankResume("en").header, fullName: "Priya Sharma" } },
    "Resume"
  ),
  "Priya-Sharma-Resume",
  "name join"
);
eq(
  outputBaseName(
    { ...blankResume("en"), header: { ...blankResume("en").header, fullName: "a/b:c d" } },
    "Resume"
  ),
  "abc-d-Resume",
  "path chars stripped, spaces → hyphens"
);
eq(
  outputBaseName(
    { ...blankResume("hi"), header: { ...blankResume("hi").header, fullName: "प्रिया शर्मा" } },
    "रिज़्यूमे"
  ),
  "प्रिया-शर्मा-रिज़्यूमे",
  "hindi name survives"
);
eq(outputBaseName(blankResume("en"), "Resume"), "Resume", "no name → file word");
eq(outputBaseName(blankResume("en"), ""), "resume", "nothing → resume");

console.log("── 5. parseResumeRun hardening ──────────────────────────");
{
  const garbage = parseResumeRun("not json {{{");
  eq(garbage.locale, "en", "garbage → en");
  eq(garbage.labels, {}, "garbage → no labels");
  eq(Array.isArray(garbage.d.sections), true, "garbage → sections array");
  eq(garbage.d.template, "classic", "garbage → classic template");

  const hi = parseResumeRun(
    JSON.stringify({ d: sampleResume("hi"), labels: LABELS, locale: "hi" })
  );
  eq(hi.locale, "hi", "locale hi round-trip");
  eq(resumeNeedsNoto(hi), true, "hindi run needs noto");
  eq(resumeNeedsNoto(parseResumeRun(JSON.stringify({ d: sampleResume("en") }))), false, "en run → helvetica");

  const enRupee = blankResume("en");
  const exp = enRupee.sections.find((s) => s.kind === "experience");
  if (exp && exp.kind === "experience") {
    exp.items[0].bullets = ["Saved ₹3 lakh per year"];
  }
  eq(
    resumeNeedsNoto(parseResumeRun(JSON.stringify({ d: enRupee }))),
    true,
    "₹ bullet flips to noto"
  );

  const sec = (id: string, kind: string): Record<string, unknown> => ({
    id,
    kind,
    title: "T",
  });
  const many = Array.from({ length: 30 }, (_, i) =>
    sec(`s${i}`, i === 0 ? "summary" : "languages")
  );
  const tampered = parseResumeRun(
    JSON.stringify({
      d: {
        ...blankResume("en"),
        header: {
          ...blankResume("en").header,
          photo: "data:image/png;base64,AAAA",
        },
        sections: [
          sec("dup", "summary"),
          sec("dup", "summary"),
          {
            id: "exp",
            kind: "experience",
            title: "X",
            items: [
              {
                id: "e1",
                role: "R",
                company: "C",
                location: "",
                start: "2020-01",
                end: "",
                current: true,
                bullets: Array.from({ length: 40 }, () => "b"),
              },
            ],
          },
          ...many,
          {
            id: "badimg",
            kind: "summary",
            title: "Y",
            text: "z",
          },
        ],
        accentColor: "not-a-color",
        template: "nope",
        pageSize: "a3",
      },
      labels: {
        fileWord: "Resume",
        notAString: 42,
        aVeryLongKeyNameIndeed: "x",
      },
      locale: "xx",
    })
  );
  eq(tampered.d.sections.length, MAX_SECTIONS, "sections clamped to 16");
  const ids = tampered.d.sections.map((s) => s.id);
  eq(new Set(ids).size, ids.length, "section ids deduped");
  eq(tampered.d.accentColor, "#0b6b4d", "bad accent → default");
  eq(tampered.d.template, "classic", "bad template → classic");
  eq(tampered.d.pageSize, "a4", "bad page size → a4");
  eq(tampered.d.header.photo, "data:image/png;base64,AAAA", "valid dataURL kept");
  eq(
    parseResumeRun(
      JSON.stringify({
        d: { ...blankResume("en"), header: { ...blankResume("en").header, photo: "data:text/html;base64,AAAA" } },
      })
    ).d.header.photo,
    "",
    "non-image dataURL dropped"
  );
  eq(
    parseResumeRun(
      JSON.stringify({
        d: { ...blankResume("en"), header: { ...blankResume("en").header, photo: "data:image/png;base64,A A" } },
      })
    ).d.header.photo,
    "",
    "space in base64 dropped"
  );
  const expSec = tampered.d.sections.find(
    (s): s is Extract<ResumeDoc["sections"][number], { kind: "experience" }> =>
      s.kind === "experience"
  );
  eq(
    expSec?.items[0].bullets.length ?? 0,
    MAX_BULLETS_PER_ITEM,
    "bullets clamped to 12"
  );
  eq(tampered.labels.fileWord, "Resume", "good label kept");
  eq("notAString" in tampered.labels, false, "non-string label dropped");
  eq("aVeryLongKeyNameIndeed" in tampered.labels, false, ">16 char label key dropped");
  eq(tampered.locale, "en", "unknown locale → en");
}

console.log("── 6. REAL vector PDF renders ──────────────────────────");
{
  const en = sampleResume("en");
  const classic = await render(en, false);
  eq(
    classic.bytes[0] === 0x25 && classic.bytes[1] === 0x50,
    true,
    `classic: %PDF magic (${classic.bytes.length} B)`
  );
  eq(classic.pages >= 1 && classic.pages <= 3, true, `classic pages (${classic.pages})`);
  const page0 = classic.reloaded.getPage(0).getSize();
  eq(
    Math.abs(page0.width - 595.28) < 0.5 && Math.abs(page0.height - 841.89) < 0.5,
    true,
    `classic A4 dims (${page0.width.toFixed(1)}×${page0.height.toFixed(1)})`
  );
  const dump = objDump(classic.reloaded);
  eq(dump.includes("Helvetica"), true, "classic: helvetica base font");
  eq(dump.includes("FontFile2"), false, "classic: NO embedded font (ATS-clean)");
  const txt = inflatedStreams(classic.bytes);
  eq(hasText(txt, "Priya"), true, "classic: name text literal in stream");
  eq(hasText(txt, "Sharma"), true, "classic: surname text in stream");
  eq(hasText(txt, "Bengaluru"), true, "classic: contact text in stream");
  eq(hasText(txt, "NaN"), false, "classic: no NaN geometry");
  eq(hasText(txt, "/Image"), false, "classic: no photo");

  const modern = await render({ ...en, template: "modern" }, false);
  eq(modern.pages >= 1, true, `modern pages (${modern.pages})`);
  const mTxt = inflatedStreams(modern.bytes);
  eq(hasText(mTxt, "Priya"), true, "modern: name text present");
  eq(hasText(mTxt, "NaN"), false, "modern: no NaN geometry");

  const compact = await render({ ...en, template: "compact" }, false);
  eq(compact.pages >= 1, true, `compact pages (${compact.pages})`);

  const letter = await render({ ...en, pageSize: "letter" }, false);
  const l0 = letter.reloaded.getPage(0).getSize();
  eq(
    Math.abs(l0.width - 612) < 0.5 && Math.abs(l0.height - 792) < 0.5,
    true,
    `letter dims (${l0.width.toFixed(1)}×${l0.height.toFixed(1)})`
  );

  const hi = await render(sampleResume("hi"), true);
  eq(hi.bytes[0] === 0x25 && hi.bytes[1] === 0x50, true, `hindi: %PDF magic (${hi.bytes.length} B)`);
  const hDump = objDump(hi.reloaded);
  eq(hDump.includes("FontFile2"), true, "hindi: noto embedded (FontFile2)");
  eq(hDump.includes("Identity-H"), true, "hindi: Type0 composite");
  eq(inflatedStreams(hi.bytes).includes("NaN"), false, "hindi: no NaN geometry");

  // long doc through the REAL renderer (pagination really breaks)
  const long = blankResume("en");
  const exp = long.sections.find((s) => s.kind === "experience");
  if (exp && exp.kind === "experience") {
    exp.items = Array.from({ length: 25 }, (_, i) => ({
      id: `x${i}`,
      role: `Role number ${i}`,
      company: `Company ${i}`,
      location: "Bengaluru",
      start: "2018-01",
      end: "2020-12",
      current: false,
      bullets: Array.from(
        { length: 6 },
        () =>
          "Delivered a large cross-team initiative with measurable impact on revenue and reliability across several quarters of careful work and stakeholder alignment."
      ),
    }));
  }
  const longOut = await render(long, false);
  eq(longOut.pages >= 3, true, `long doc real pages ≥3 (${longOut.pages})`);
  eq(
    inflatedStreams(longOut.bytes).includes("NaN"),
    false,
    "long doc: no NaN geometry"
  );

  // photo — awaited embed proof (pinned lesson): real Do operator
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const withPhoto = { ...en, header: { ...en.header, photo: png } };
  const photoOut = await render(withPhoto, false);
  eq(photoOut.photo, true, "photo report");
  const pDump = objDump(photoOut.reloaded);
  eq(/\/Subtype \/Image/.test(pDump), true, "photo: XObject image object");
  eq(
    /\/[A-Za-z][\w-]*\s+Do\b/.test(inflatedStreams(photoOut.bytes)),
    true,
    "photo: real Do draw operator"
  );
  eq(
    parseResumeRun(
      JSON.stringify({ d: withPhoto })
    ).d.header.photo.startsWith("data:image/png"),
    true,
    "photo survives the boundary parser"
  );
}

console.log("── 7. Round-trip: surface JSON → parser → render ────────");
{
  const doc = sampleResume("hi");
  const run = parseResumeRun(
    JSON.stringify({ d: doc, labels: LABELS, locale: "hi" })
  );
  const out = await render(run.d, true);
  eq(out.pages >= 1, true, `hi round-trip pages (${out.pages})`);
  eq(objDump(out.reloaded).includes("FontFile2"), true, "hi round-trip: noto kept");
}

/* ------------------------------------------------------------------ */
console.log(
  `\ncreate-resume smoke: ${pass} passed, ${fail} failed` +
    (fail ? "\n  " + failures.join("\n  ") : "")
);
process.exit(fail === 0 ? 0 : 1);
