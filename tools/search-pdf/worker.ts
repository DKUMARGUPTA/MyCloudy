import type { WorkerRunRequest, WorkerResponse } from "@/lib/workers/protocol";

import {
  loadPdfjsInWorker,
  workerDocumentShim,
} from "../pdfjs-common/worker-lib";

import {
  BadRegexError,
  buildMatcher,
  classifySearchError,
  findMatches,
  joinPageText,
  makeSnippet,
  MAX_MATCHES_PER_FILE,
  resolveSearchOptions,
  type RawTextItem,
  type Snippet,
} from "./engine";

/**
 * Search PDFs worker (PRD §8.5). pdf.js runs IN THIS WORKER (fake-worker
 * mode, same recipe as pdf-to-txt): every page of every file is read with
 * getTextContent, joined with the shared simplified recipe (joinPageText)
 * and run through the same matcher the live surface uses — so a preview
 * match and a report match are the same match.
 *
 * The output is ONE human-readable report, `search-results.txt`, grouped by
 * file: "name — N matches" followed by one "page N: …hit…" line per match
 * (capped at 500 stored matches per file — the true count is reported and
 * the truncation is noted honestly).
 *
 * Device-only: the Files arrive by structured clone, the text Blob goes
 * back the same way. Nothing ever leaves the device.
 */

type PdfjsModule = typeof import("pdfjs-dist");

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

interface FileHit {
  name: string;
  pageCount: number;
  /** True match count (cap applies to stored lines only). */
  total: number;
  lines: string[];
  capped: boolean;
}

/** One report line for a match: "  p3: …before [HIT] after…". */
function matchLine(page: number, snippet: Snippet): string {
  return `  p${page}: ${snippet.before}[ ${snippet.hit} ]${snippet.after}`;
}

/** Assemble the whole report body (human-readable, grouped by file). */
function buildReport(
  query: string,
  mode: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  hits: FileHit[],
  totalPages: number
): string {
  const totalMatches = hits.reduce((sum, hit) => sum + hit.total, 0);
  const head: string[] = [
    "PDF search results",
    "==================",
    "",
    `Query: "${query}" (${mode}, ${caseSensitive ? "case-sensitive" : "case-insensitive"}${wholeWord && mode === "text" ? ", whole words" : ""})`,
    `Files searched: ${hits.length} | Pages read: ${totalPages} | Matches: ${totalMatches}`,
    "",
  ];
  const sections: string[] = [];
  for (const hit of hits) {
    if (hit.total === 0) {
      sections.push(`${hit.name} — 0 matches`);
      continue;
    }
    const label =
      hit.total === 1 ? "1 match" : `${hit.total} matches`;
    sections.push(`${hit.name} (${hit.pageCount} pages) — ${label}`);
    for (const line of hit.lines) sections.push(line);
    if (hit.capped) {
      sections.push(
        `  … showing the first ${MAX_MATCHES_PER_FILE} — more matches exist in this file`
      );
    }
  }
  return [...head, ...sections, ""].join("\n");
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files } = request;
  const opts = resolveSearchOptions(options);

  // Validate before touching any file — cheap, honest, immediate.
  if (opts.query.trim() === "") {
    post({ type: "error", runId, code: "search.errorEmptyQuery" });
    return;
  }
  const matcher = (() => {
    try {
      return buildMatcher(opts.query, {
        mode: opts.mode,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
      });
    } catch (error) {
      if (error instanceof BadRegexError) return null;
      throw error;
    }
  })();
  if (matcher === null) {
    post({ type: "error", runId, code: "search.errorBadRegex" });
    return;
  }

  const pdfjs = await loadPdfjsInWorker();
  const hits: FileHit[] = [];
  let totalPages = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const hit: FileHit = {
      name: file.name,
      pageCount: 0,
      total: 0,
      lines: [],
      capped: false,
    };

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      // Worker-safe canvas factory — image pages need createElement
      // (DOMCanvasFactory._createCanvas), the baseURI-only shim blanks them.
      ownerDocument: workerDocumentShim() as unknown as HTMLDocument,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    }).promise;
    hit.pageCount = doc.numPages;

    try {
      for (let page = 1; page <= doc.numPages; page += 1) {
        const pdfPage = await doc.getPage(page);
        const content = await pdfPage.getTextContent();
        pdfPage.cleanup();
        const pageText = joinPageText(content.items as RawTextItem[]);
        const matches = findMatches(pageText, matcher);
        for (const match of matches) {
          hit.total += 1;
          if (hit.lines.length < MAX_MATCHES_PER_FILE) {
            hit.lines.push(
              matchLine(
                page,
                makeSnippet(pageText, match, opts.context)
              )
            );
          } else {
            hit.capped = true;
          }
        }
        totalPages += 1;
        post({
          type: "progress",
          runId,
          pct: Math.round(
            ((fileIndex + page / doc.numPages) / files.length) * 95
          ),
          stage: "processing",
          detail: { page, pages: doc.numPages },
        });
      }
    } finally {
      await doc.destroy().catch(() => undefined);
    }

    hits.push(hit);
  }

  post({ type: "progress", runId, pct: 97, stage: "saving" });
  const body = buildReport(
    opts.query,
    opts.mode,
    opts.caseSensitive,
    opts.wholeWord,
    hits,
    totalPages
  );
  post({
    type: "result",
    runId,
    outputs: [
      {
        name: "search-results.txt",
        mime: "text/plain;charset=utf-8",
        blob: new Blob([body], { type: "text/plain;charset=utf-8" }),
      },
    ],
    // The shell's fixed summary chip reads "{files} files, {pages} pages",
    // so both numbers describe the SEARCH ITSELF (files read, pages read);
    // match counts live in the report + the live preview.
    detail: { files: files.length, pages: totalPages },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>) => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: classifySearchError(message),
    });
  });
};
