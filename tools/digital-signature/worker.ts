import {
  PdfError,
  StampContext,
  readAcroFormFields,
  type StampTtfFont,
} from "@/lib/own/pdf";

import type { OptionValues } from "@/lib/tools/config-types";
import type {
  WorkerRunRequest,
  WorkerResponse,
} from "@/lib/workers/protocol";
import { loadDevanagariBytes } from "../stamp-common/deva";
import {
  DS_CODES,
  MAX_PASSWORD_CHARS,
  MAX_PDF_BYTES,
  SignError,
  estimateCmsLength,
  finalizeSignedPdf,
  formatSignDate,
  hasExistingSignature,
  parseSignRun,
  sigFieldName,
  signedFileName,
} from "./model";
import { P12Error, parsePkcs12 } from "./pkcs12";
import {
  addSignatureField,
  blockNeedsNoto,
  drawSignatureBlock,
} from "./render";

/**
 * Digital signature worker (RB6-FIN-a4, security — 100% on-device).
 *
 *  1. load the PDF on the OWN engine (encrypted → honest error, unreadable
 *     → corrupt);
 *  2. take the .pfx/.p12 run ASSET (collectAssets bridge) and parse +
 *     decrypt it with the pure-TS PKCS#12 core (MAC-verified, PBES2 via
 *     WebCrypto, legacy 3DES/RC2 via ciphers.ts — RSA keys only);
 *  3. size the /Contents gap with a DRY-RUN CMS build (same cert, same
 *     key, same signingTime — the real CMS always fits);
 *  4. optional visible block (vector ink, WinAnsi-vs-Noto split runs)
 *     + the REAL AcroForm /FT /Sig field with the /V placeholder dict;
 *  5. write WITHOUT object streams (the engine's classic writer — the sig
 *     dict lands as plain bytes), then the byte surgeon: patch the
 *     /ByteRange digits at fixed width, SHA-256 the covered ranges, build
 *     the real CMS, splice the hex.
 *
 * Output: <base>-signed.pdf (localized suffix in Hindi).
 *
 * Error mapping:
 *   ds.errNoP12File     no certificate asset on the run
 *   ds.errEmptyFile     the PDF has no bytes
 *   ds.errTooLarge      the PDF is past the honest cap
 *   ds.errWrongPassword MAC / padding says the password is wrong
 *   ds.errNotP12        not a parseable PKCS#12 container
 *   ds.errUnsupported   an encryption this parser does not carry
 *   ds.errNoKey         container has no private-key bag
 *   ds.errNotRsa        the key is ECDSA/EdDSA — honestly refused
 *   ds.errSignFailed    the CMS build or the byte surgery failed
 *   tool.errorEncrypted / tool.errorCorrupt / tool.errorGeneric  shared
 */

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function readPassword(options: OptionValues): string {
  const v = options["password"];
  return typeof v === "string" ? v.slice(0, MAX_PASSWORD_CHARS) : "";
}

async function run(request: WorkerRunRequest): Promise<void> {
  const { runId, options, files, assets } = request;
  const file = files[0];
  if (!file) {
    post({ type: "error", runId, code: "tool.errorGeneric" });
    return;
  }
  const p12File = assets !== undefined && assets.length > 0 ? assets[0] : undefined;
  if (p12File === undefined) {
    post({ type: "error", runId, code: DS_CODES.noP12 });
    return;
  }

  post({ type: "progress", runId, pct: 3, stage: "reading" });

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }
  if (bytes.length === 0) {
    post({ type: "error", runId, code: DS_CODES.emptyFile });
    return;
  }
  if (bytes.length > MAX_PDF_BYTES) {
    post({ type: "error", runId, code: DS_CODES.tooLarge });
    return;
  }

  if (hasExistingSignature(bytes)) {
    post({ type: "error", runId, code: DS_CODES.alreadySigned });
    return;
  }

  let ctx: StampContext;
  try {
    ctx = StampContext.load(bytes);
  } catch (error) {
    // Own-engine typed errors (PdfError carries a code).
    if (error instanceof PdfError) {
      post({
        type: "error",
        runId,
        code: error.code === "encrypted" ? "tool.errorEncrypted" : "tool.errorCorrupt",
      });
      return;
    }
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  const pageCount = ctx.pageCount;
  if (pageCount < 1) {
    post({ type: "error", runId, code: "tool.errorCorrupt" });
    return;
  }

  const parsed = parseSignRun(options["sign"], pageCount);
  if (!parsed.ok) {
    post({ type: "error", runId, code: parsed.code });
    return;
  }
  const signRun = parsed.run;
  const password = readPassword(options);

  post({ type: "progress", runId, pct: 14, stage: "processing" });

  // --- the certificate ------------------------------------------------
  let p12Bytes: Uint8Array;
  try {
    p12Bytes = new Uint8Array(await p12File.arrayBuffer());
  } catch {
    post({ type: "error", runId, code: DS_CODES.noP12 });
    return;
  }

  let creds;
  try {
    creds = await parsePkcs12(p12Bytes, password);
  } catch (error) {
    if (error instanceof P12Error) {
      post({ type: "error", runId, code: error.code });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
    return;
  }

  post({ type: "progress", runId, pct: 30, stage: "processing" });

  // --- the gap sizing + the block + the field --------------------------
  const signingTime = new Date();
  const placeholderLen = await estimateCmsLength(
    { pkcs8: creds.pkcs8, certDer: creds.certDer },
    signingTime
  );
  const placeholderHexLen = placeholderLen * 2;

  post({ type: "progress", runId, pct: 44, stage: "processing" });

  const slot = Math.min(signRun.page, pageCount - 1);
  const signDate = formatSignDate(signingTime);

  let blockRect = { x: 0, y: 0, w: 0, h: 0 };
  if (signRun.visible) {
    const needDeva = blockNeedsNoto(signRun, creds.summary, signDate);
    // The split-run font bundle: base-14 keys embed nothing; the
    // Devanagari face embeds only when the content needs it.
    let deva: StampTtfFont | null = null;
    if (needDeva) {
      deva = ctx.embedTtf(await loadDevanagariBytes());
    }
    const plan = drawSignatureBlock(ctx, slot, signRun, creds.summary, signDate, {
      base: "helvetica",
      bold: "helveticaBold",
      deva,
    });
    blockRect = { x: plan.rect.x, y: plan.rect.y, w: plan.rect.w, h: plan.rect.h };
  }

  const existingNames = new Set<string>();
  for (const field of readAcroFormFields(ctx.doc)) {
    if (field.name !== "") existingNames.add(field.name);
  }
  addSignatureField(ctx, slot, {
    placeholderHexLen,
    reason: signRun.reason,
    location: signRun.location,
    signingTime,
    rect: blockRect,
    fieldName: sigFieldName(existingNames),
    signerName: creds.summary.subjectCn,
  });

  post({ type: "progress", runId, pct: 60, stage: "saving" });

  // --- write flat (classic writer, no ObjStm), then the byte surgeon ----
  const saved = ctx.write();

  post({ type: "progress", runId, pct: 76, stage: "processing" });

  let signed;
  try {
    signed = await finalizeSignedPdf(saved, {
      pkcs8: creds.pkcs8,
      certDer: creds.certDer,
      signingTime,
      placeholderHexLen,
    });
  } catch (error) {
    if (error instanceof SignError) {
      post({ type: "error", runId, code: error.code });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId,
      code: "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
    return;
  }

  post({ type: "progress", runId, pct: 92, stage: "saving" });

  post({
    type: "result",
    runId,
    outputs: [
      {
        name: signedFileName(file.name, signRun.locale),
        mime: "application/pdf",
        blob: new Blob([signed.bytes as unknown as BlobPart], {
          type: "application/pdf",
        }),
      },
    ],
    detail: {
      files: 1,
      pages: pageCount,
    },
  });
}

self.onmessage = (event: MessageEvent<WorkerRunRequest>): void => {
  const data = event.data;
  if (data?.type !== "run") return;
  run(data).catch((error: unknown) => {
    if (error instanceof PdfError) {
      post({
        type: "error",
        runId: data.runId,
        code: error.code === "encrypted" ? "tool.errorEncrypted" : "tool.errorGeneric",
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: "error",
      runId: data.runId,
      code: /encrypt/i.test(message) ? "tool.errorEncrypted" : "tool.errorGeneric",
      detail: message.slice(0, 200),
    });
  });
};
