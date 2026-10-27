/**
 * e-invoice PDF engine (P12-EINVOICE).
 *
 * Two build paths, both entirely on-device with @cantoo/pdf-lib (the fork
 * that ships embedFacturX — PDF/A-3 conversion with the bundled sRGB ICC
 * profile, the fx: XMP + PDF/A extension schema, and a name-tree-aware
 * attach that also pushes the /AF entry):
 *
 *   buildEInvoiceArtifact — the CREATE path: form → CII XML → the same
 *     drawEInvoice sheet the xml-invoice-to-pdf tool renders (fed by
 *     re-parsing our own XML, so the sheet and the embedded data are the
 *     same data) → embedFacturX → save → reload-and-verify.
 *
 *   embedEInvoiceIntoPdf — the EMBED path: the user's existing PDF plus
 *     finished CII XML (typed in the shared form or pasted) → the same
 *     Factur-X embedding.
 *
 * Self-verification (the P11 pattern): both paths RE-LOAD the saved bytes
 * and compare the embedded XML with the intended XML — a run only
 * succeeds when the artifact really carries the data.
 */

import {
  PDFDocument,
  embedFacturX,
} from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";

import { parseEInvoice, type EInvoice } from "../xml-invoice-to-pdf/engine";
import { drawEInvoice, type EInvoiceLabels } from "../xml-invoice-to-pdf/render";
import { ciiBytes } from "./cii";
import { computeForm, type EInvFormState } from "./model";

export type { EInvoiceLabels };

const DEVA_FONT_URL = "/fonts/NotoSansDevanagari-Regular.ttf";

/** Absolute font URL that also works for Turbopack blob: workers. */
export function devaFontUrl(): string {
  try {
    const viaLocation = new URL(DEVA_FONT_URL, self.location.href);
    if (viaLocation.protocol === "http:" || viaLocation.protocol === "https:") {
      return viaLocation.href;
    }
  } catch {
    /* opaque base — fall through */
  }
  try {
    const blobOrigin = /^blob:(https?:\/\/[^/]+)/i.exec(self.location.href);
    if (blobOrigin) return `${blobOrigin[1]}${DEVA_FONT_URL}`;
  } catch {
    /* no location in bun — callers inject fontBytes instead */
  }
  return DEVA_FONT_URL;
}

let devaBytesPromise: Promise<Uint8Array> | null = null;

/** Self-hosted Devanagari TTF (covers ₹ + Latin + हिंदी), one fetch per lifetime. */
export function fetchDevaFontBytes(): Promise<Uint8Array> {
  if (!devaBytesPromise) {
    devaBytesPromise = fetch(devaFontUrl()).then(async (res) => {
      if (!res.ok) throw new Error("devanagari-font-fetch");
      return new Uint8Array(await res.arrayBuffer());
    });
    devaBytesPromise.catch(() => {
      devaBytesPromise = null;
    });
  }
  return devaBytesPromise;
}

export interface EInvArtifact {
  bytes: Uint8Array;
  xml: Uint8Array;
  pages: number;
  /** The parsed invoice (from re-reading our own XML — the render source). */
  inv: EInvoice;
}

export interface EInvBuildOptions {
  labels: EInvoiceLabels;
  accent: string;
  /** Tests inject the TTF; workers fetch it (see fetchDevaFontBytes). */
  fontBytes?: Uint8Array;
}

/** XML the worker refuses to emit when its own reader finds an inconsistency. */
export function buildCiiChecked(form: EInvFormState): {
  xml: Uint8Array;
  inv: EInvoice;
} {
  const computed = computeForm(form);
  if (computed.lines.length === 0) throw new Error("einv.errorNoLines");
  const xml = ciiBytes(form, computed);

  // Self-check #1: the SAME reader the validate tool uses must accept it.
  let inv: EInvoice;
  try {
    inv = parseEInvoice(xml);
  } catch {
    throw new Error("einv.errorSelfCheck");
  }
  if (!inv.checks.every((c) => c.ok)) throw new Error("einv.errorSelfCheck");
  if (inv.number === "" || inv.currency === "") throw new Error("einv.errorSelfCheck");
  return { xml, inv };
}

/** CREATE path: form → single hybrid PDF/A-3 e-invoice. */
export async function buildEInvoiceArtifact(
  form: EInvFormState,
  options: EInvBuildOptions
): Promise<EInvArtifact> {
  const { xml, inv } = buildCiiChecked(form);

  const doc = await PDFDocument.create();
  doc.setTitle(form.number.trim() || "e-invoice", { showInWindowTitleBar: false });
  doc.setCreator("DocoPDF");
  doc.setProducer("DocoPDF (on-device)");
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());

  // One embedded font for everything (PDF/A needs embedded fonts; the
  // Devanagari subset also covers ₹ + Latin, so EN/हिंदी sheets both work).
  doc.registerFontkit(fontkit as unknown as Parameters<
    typeof doc.registerFontkit
  >[0]);
  const fontBytes = options.fontBytes ?? (await fetchDevaFontBytes());
  const font = await doc.embedFont(fontBytes, { subset: true });

  // The sheet is drawn from the RE-PARSED XML — the human-readable page and
  // the machine-readable attachment can never disagree.
  await drawEInvoice(
    doc as unknown as Parameters<typeof drawEInvoice>[0],
    font as unknown as Parameters<typeof drawEInvoice>[1],
    inv,
    options.labels,
    options.accent
  );

  await embedFacturX(doc, xml, {
    conformanceLevel: "EN 16931",
    description: "Factur-X invoice data",
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  const bytes = await doc.save();
  const pages = await verifyEmbed(bytes, xml);
  return { bytes, xml, pages, inv };
}

export interface EInvEmbedResult {
  bytes: Uint8Array;
  pages: number;
  /** A same-named attachment existed and was replaced. */
  replaced: boolean;
}

/** EMBED path: the user's PDF + finished CII XML → hybrid e-invoice. */
export async function embedEInvoiceIntoPdf(
  pdfBytes: Uint8Array,
  xmlBytes: Uint8Array
): Promise<EInvEmbedResult> {
  let doc: Awaited<ReturnType<typeof PDFDocument.load>>;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/encrypted/i.test(message)) throw new Error("einv.errorEncrypted");
    throw new Error("einv.errorNotPdf");
  }

  const existing = doc.getAttachments();
  const replaced = existing.some((a) => a.name === "factur-x.xml");

  await embedFacturX(doc, xmlBytes, {
    conformanceLevel: "EN 16931",
    description: "Factur-X invoice data",
    creationDate: new Date(),
    modificationDate: new Date(),
  });

  const bytes = await doc.save();
  const pages = await verifyEmbed(bytes, xmlBytes);
  return { bytes, pages, replaced };
}

/**
 * Self-verification: reload the saved bytes and prove the embedded XML is
 * byte-identical to what we intended to ship (P11 refuse-to-emit-unverified).
 */
async function verifyEmbed(bytes: Uint8Array, xml: Uint8Array): Promise<number> {
  const reloaded = await PDFDocument.load(bytes);
  const attachment = reloaded
    .getAttachments()
    .find((a) => a.name === "factur-x.xml");
  if (
    !attachment ||
    attachment.data.length !== xml.length ||
    !attachment.data.every((b, i) => b === xml[i])
  ) {
    throw new Error("einv.errorEmbed");
  }
  return reloaded.getPageCount();
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
