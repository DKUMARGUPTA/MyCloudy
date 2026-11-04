import { CreateContext, type StampFontKey } from "@/lib/own/pdf";

import {
  type WorkerRunRequest,
  type WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import type { ConvertFace } from "../convert-common/face";
import { isWinAnsiText } from "../excel-to-pdf/model";
import { EmlParseError, parseEml, type EmailDoc } from "./worker-lib";
import { renderEmail, type EmailPageSize } from "./render";

/**
 * Email to PDF worker (P3-c — create-resume protocol):
 *
 *  1. every file's bytes → OWN pure EML parser (RFC 5322 + MIME walk,
 *     RFC 2047 subjects, QP/base64 bodies, charsets) — a file without
 *     recognizable message headers is refused honestly (errorNotEmail);
 *  2. each email renders as its own section starting a fresh page via
 *     the shared painter (tools/email-to-pdf/render.ts — smoke-driven):
 *     header block, divider, wrapped body, attachment list;
 *  3. font pick — any non-WinAnsi character (Devanagari, ₹) embeds the
 *     self-hosted Noto Sans Devanagari subset;
 *  4. written on the OWN engine with producer "DocoPDF".
 */

function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

async function run(request: WorkerRunRequest): Promise<void> {
  const runId = request.runId;
  const post = (msg: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(msg);
  };
  try {
    if (request.files.length === 0) {
      post({ type: "error", runId, code: "tool.errorNoFile" });
      return;
    }

    const pageSize: EmailPageSize =
      String(request.options.pageSize ?? "a4") === "letter" ? "letter" : "a4";
    const includeHeaders = request.options.includeHeaders !== false;
    const includeAttachments = request.options.includeAttachments !== false;

    const emails: EmailDoc[] = [];
    for (const [i, file] of request.files.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        emails.push(parseEml(bytes));
      } catch (error) {
        if (error instanceof EmlParseError) {
          post({ type: "error", runId, code: "tool.errorNotEmail", detail: file.name });
          return;
        }
        throw error;
      }
      post({
        type: "progress",
        runId,
        pct: 10 + Math.round(((i + 1) / request.files.length) * 35),
        stage: "reading",
      });
    }

    const doc = CreateContext.create();
    const allText = emails
      .map((e) =>
        [e.subject, e.from, e.to, e.cc, e.body, ...e.attachments.map((a) => a.filename)].join("\n"),
      )
      .join("\n");
    let face: ConvertFace;
    let boldKey: StampFontKey | null = null;
    if (isWinAnsiText(allText)) {
      face = { std: "helvetica" };
      boldKey = "helveticaBold";
    } else {
      const notoBytes = await loadDevanagariBytes();
      face = { ttf: doc.embedTtf(notoBytes) };
    }

    let pages = 0;
    let attachments = 0;
    for (const [i, email] of emails.entries()) {
      pages += renderEmail(doc, email, face, boldKey, pageSize, includeHeaders, includeAttachments);
      attachments += email.attachments.length;
      post({
        type: "progress",
        runId,
        pct: 50 + Math.round(((i + 1) / emails.length) * 42),
        stage: "processing",
      });
    }

    post({ type: "progress", runId, pct: 95, stage: "saving" });

    const title = baseName(request.files[0]!.name);
    doc.setProducer("DocoPDF");
    doc.setCreator("DocoPDF");
    doc.setTitle(emails[0]?.subject || title);
    doc.setCreationDate(new Date());

    const outBytes = doc.write();
    post({
      type: "result",
      runId,
      outputs: [
        {
          name: `${title}.pdf`,
          mime: "application/pdf",
          blob: new Blob([outBytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
        },
      ],
      detail: {
        files: emails.length,
        pages,
        attachments,
      },
    });
  } catch (error) {
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  if (event.data?.type === "run") void run(event.data);
};
