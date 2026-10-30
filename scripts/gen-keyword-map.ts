/**
 * P7-SEO Phase 1 — Keyword-map deliverables generator.
 *
 * Writes two CSVs (committed for the owner / future content work):
 *   seo/keyword-map.csv          — full per-tool keyword map (EN + HI +
 *                                  Hinglish, intent, tier, regions, FAQ
 *                                  questions) sourced from the registry +
 *                                  src/lib/seo/tool-seo.ts researched copy.
 *   seo/keyword-planner-seed.csv — plain keyword list in the shape Google Ads
 *                                  Keyword Planner accepts (OWNER ACTION:
 *                                  Tools → Planning → Get search volume and
 *                                  forecasts → Upload file).
 *
 * Tier formula (master plan): rank enabled tools by registry popularity,
 * top 12 = T1 head tools, next 30 = T2, rest = T3.
 *
 * Run: bun scripts/gen-keyword-map.ts
 */
import { mkdir, writeFile } from "node:fs/promises";

import { ALL_TOOLS, CATEGORIES } from "../src/lib/tools/registry";
import { getToolSeo } from "../src/lib/seo/tool-seo";
import { getToolConfig } from "../src/lib/tools/configs";

const SITE = "https://www.docopdf.com";

/** Hand-written Hinglish (Roman-Hindi) variants for the T1 head tools. */
const HINGLISH: Record<string, string[]> = {
  "merge-pdf": ["pdf jodne wala app", "pdf merge kaise kare", "do pdf kaise jode"],
  "split-pdf": ["pdf split kaise kare", "pdf ko parts me kaise todde"],
  "compress-pdf": ["pdf compress kaise kare", "pdf ka size kam karne wala app", "pdf chhoti kaise kare"],
  "jpg-to-pdf": ["jpg se pdf kaise banaye", "photo ko pdf me kaise badle"],
  "pdf-to-word": ["pdf to word kaise kare", "pdf se word file kaise banaye"],
  "pdf-to-jpg": ["pdf to jpg kaise kare", "pdf ki photo kaise nikale"],
  "edit-pdf": ["pdf edit kaise kare", "pdf me likhne ka tarika", "pdf modifier app"],
  "sign-pdf": ["pdf par sign kaise kare", "digital signature pdf kaise lagaye"],
  "unlock-pdf": ["pdf ka password kaise hate", "pdf unlock kaise kare"],
  "lock-pdf": ["pdf me password kaise lagaye", "pdf lock kaise kare"],
  "ocr-pdf": ["pdf ocr kaise kare", "scanned pdf me se text kaise nikale"],
  "pdf-to-text": ["pdf se text kaise copy kare", "pdf ka text kaise nikale"],
  "word-to-pdf": ["word se pdf kaise banaye", "docx to pdf converter"],
  "images-to-pdf": ["photos ko pdf me kaise jode", "multiple image to pdf"],
  "pdf-to-excel": ["pdf to excel kaise kare", "pdf se excel file"],
  "watermark-pdf": ["pdf me watermark kaise lagaye"],
  "rotate-pdf": ["pdf page ghumane ka app", "pdf rotate kaise kare"],
  "repair-pdf": ["corrupt pdf kaise theek kare", "pdf repair tool"],
};

/** Intent by category (a tools site is tool-intent everywhere; nuance below). */
const INTENT: Record<string, string> = {
  organize: "do-task (organize pages)",
  edit: "do-task (edit content)",
  "convert-to": "convert (X → PDF)",
  "convert-from": "convert (PDF → X)",
  security: "do-task (protect / unlock)",
  optimize: "do-task (compress / fix)",
  create: "do-task (author new)",
  invoices: "do-task (business docs)",
  view: "read + extract",
  images: "convert (image ↔ image/PDF)",
};

function csvEscape(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

async function main() {
  const enabled = ALL_TOOLS.filter((t) => t.enabled);
  // Tier assignment: popularity rank → T1 (top 12), T2 (next 30), T3 (rest).
  const ranked = [...enabled].sort((a, b) => b.popularity - a.popularity);
  const tierOf = new Map<string, string>();
  ranked.forEach((t, i) => {
    tierOf.set(t.id, i < 12 ? "T1" : i < 42 ? "T2" : "T3");
  });

  const mapRows: string[] = [];
  const seedRows: string[] = [];

  // Header — keyword map.
  mapRows.push(
    [
      "tool_id",
      "url",
      "url_hi",
      "category",
      "tier",
      "mode",
      "primary_keyword",
      "secondary_keywords",
      "question_keywords_from_faq",
      "hindi_keywords_devanagari",
      "hinglish_variants_roman",
      "intent",
      "regions",
      "popularity",
      "title_en",
      "title_hi",
    ]
      .map(csvEscape)
      .join(",")
  );

  // Header — Keyword Planner seed (Keyword Planner accepts a plain keyword
  // list; the extra columns are for the owner's reference only).
  seedRows.push(["Keyword", "Language", "Tool", "URL", "Tier"].map(csvEscape).join(","));

  for (const tool of enabled) {
    const seo = getToolSeo(tool.id);
    const config = getToolConfig(tool.id);
    const tier = tierOf.get(tool.id) ?? "T3";
    const url = `${SITE}/tool/${tool.id}`;
    const urlHi = `${SITE}/hi/tool/${tool.id}`;

    const primary = seo?.keywords[0] ?? tool.name.en.toLowerCase();
    const secondary = (seo?.keywords ?? []).slice(1, 9).join("; ");
    const questions = (config?.faq ?? [])
      .map((f) => f.q.en.replace(/\s+/g, " ").replace(/"/g, "'").trim())
      .filter((q) => q.endsWith("?"))
      .slice(0, 4)
      .join("; ");
    const hindi = [...new Set([...(seo?.keywordsHi ?? []), ...tool.tags.hi])]
      .slice(0, 10)
      .join("; ");
    const hinglish = (HINGLISH[tool.id] ?? []).join("; ");
    const intent = INTENT[tool.category] ?? "do-task";
    const regions = "Global (US/UK/CA/AU/EU) + India";

    mapRows.push(
      [
        tool.id,
        url,
        urlHi,
        tool.category,
        tier,
        tool.mode,
        primary,
        secondary,
        questions,
        hindi,
        hinglish,
        intent,
        regions,
        String(tool.popularity),
        seo?.title ?? tool.name.en,
        seo?.titleHi ?? tool.name.hi,
      ]
        .map(csvEscape)
        .join(",")
    );

    // Planner seed: primary + up to 5 strongest secondary per tool (EN),
    // plus Hindi variants for every tool (Language = hi).
    const enKw = [primary, ...(seo?.keywords ?? []).slice(1, 6)];
    for (const kw of enKw) {
      seedRows.push([kw, "en", tool.id, url, tier].map(csvEscape).join(","));
    }
    for (const kw of (seo?.keywordsHi ?? []).slice(0, 4)) {
      seedRows.push([kw, "hi", tool.id, urlHi, tier].map(csvEscape).join(","));
    }
    for (const kw of HINGLISH[tool.id] ?? []) {
      seedRows.push([kw, "hinglish", tool.id, url, tier].map(csvEscape).join(","));
    }
  }

  // Category hub rows in the map (hubs are their own ranking surface).
  for (const cat of CATEGORIES) {
    mapRows.push(
      [
        `hub:${cat.id}`,
        `${SITE}/tools/${cat.id}`,
        `${SITE}/hi/tools/${cat.id}`,
        cat.id,
        "hub",
        "n/a",
        cat.name.en.toLowerCase() + " pdf tools",
        `pdf ${cat.name.en.toLowerCase()}; free ${cat.name.en.toLowerCase()} tools; ${cat.name.en.toLowerCase()} pdf tools online`,
        "",
        `पीडीएफ़ ${cat.name.hi} टूल्स; मुफ़्त पीडीएफ़ टूल्स`,
        "",
        "navigate (category hub)",
        "Global + India",
        "",
        `${cat.name.en} PDF Tools`,
        `${cat.name.hi} पीडीएफ़ टूल्स`,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  await mkdir("seo", { recursive: true });
  await writeFile("seo/keyword-map.csv", mapRows.join("\n") + "\n", "utf-8");
  await writeFile("seo/keyword-planner-seed.csv", seedRows.join("\n") + "\n", "utf-8");

  console.log(
    `keyword-map.csv: ${mapRows.length - 1} rows (${enabled.length} tools + ${CATEGORIES.length} hubs)`
  );
  console.log(`keyword-planner-seed.csv: ${seedRows.length - 1} keywords`);
  console.log(
    `T1 head tools: ${ranked
      .slice(0, 12)
      .map((t) => t.id)
      .join(", ")}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
