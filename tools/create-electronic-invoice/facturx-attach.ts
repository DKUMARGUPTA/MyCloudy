import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  PDFDocument,
  PDFObject,
  PDFRef,
} from "pdf-lib";

/**
 * Factur-X attachment surgery (Task b6-c) — PURE pdf-lib low-level
 * object writing (the bookmark-pdf / meta-common precedents), no
 * browser APIs: the same code runs in the tool workers and under bun
 * in the smokes.
 *
 * What attachFacturx does to the source catalog, per the Factur-X
 * (FNFE-MFE) attachment structure:
 *
 *   1. EmbeddedFile stream — PDFRawStream with dict { Type /EmbeddedFile,
 *      Subtype /text#2Fxml (that IS how "text/xml" is written in a PDF
 *      name — pdf-lib's PDFName.of decodes the "#2F" escape), Params {
 *      Size, ModDate } } registered in the context.
 *   2. Filespec dict — { Type /Filespec, F "factur-x.xml" (PDF literal),
 *      UF <FEFF…> (UTF-16BE hex), EF { F <stream>, UF <stream> },
 *      AFRelationship /Data }.
 *   3. Catalog /AF — the filespec ref APPENDED to any existing array
 *      (merge, never clobber).
 *   4. Catalog /Names /EmbeddedFiles — the [ <FEFF…>, filespecRef ]
 *      pair appended to the existing name tree's flat Names array
 *      (created when absent; other /Names keys preserved). Name-tree
 *      /Kids are followed to the first leaf. Entries land at the end
 *      — strict binary-search lookups should use /AF (which the spec
 *      itself keys on); pdf.js's getAll() reads flat arrays fine.
 *   5. XMP metadata stream — the spec's packet (fx:DocumentType
 *      INVOICE, fx:DocumentFileName factur-x.xml, fx:Version 1.0, the
 *      pdfaExtension schema block, pdf:Producer). The /pdfaid:part +
 *      /pdfaid:conformance lines ship ONLY when PDF/A identification
 *      is being claimed — MyCloudy never writes an identification the
 *      file cannot back.
 *   6. OutputIntent — ONLY when claiming PDF/A: { S /GTS_PDFA1,
 *      OutputConditionIdentifier "sRGB", DestOutputProfile <ICC stream> }.
 *      When the source already carries OutputIntents they are kept
 *      untouched (the source's own profile backs the claim); the ICC
 *      stream is { N 3 } + the raw profile bytes.
 *
 * HONESTY CONTRACT (non-negotiable): `claimPdfa` is the caller's
 * decision — the WORKER derives it honestly (the pdfa select's
 * auto mode claims only when the source PDF itself carries a pdfaid
 * identification; "always" forces it; "never" forbids it). Claiming
 * requires ICC bytes; attachFacturx throws without them rather than
 * writing a claim it cannot back.
 */

/** The attachment description string in the filespec. */
const FILESPEC_DESC = "Factur-X Invoice";

/** XMP packet producer default. */
const DEFAULT_PRODUCER = "MyCloudy";

/** The fixed XMP xpacket id Adobe tooling writes. */
const XPACKET_ID = "W5M0MpCehiHzreSzNTczkc9d";

/* ------------------------------------------------------------------ */
/* XMP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Builds the Factur-X XMP packet. The pdfaid:part/conformance lines
 * are emitted ONLY when claiming PDF/A-3 identification; the fx:
 * extension properties (the attachment identification) always ship.
 * `producer` lands in pdf:Producer.
 */
export function buildFacturxXmp(
  claimed: boolean,
  producer: string
): string {
  const pdfaid =
    claimed === true
      ? "<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>"
      : "";
  return `<?xpacket begin="" id="${XPACKET_ID}"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">${pdfaid}<pdf:Producer>${escapeXml(
    producer
  )}</pdf:Producer><pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaExtension:schema>Factur-X PDFA Extension Schema</pdfaExtension:schema><pdfaExtension:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaExtension:namespaceURI><pdfaExtension:prefix>fx</pdfaExtension:prefix><pdfaExtension:property><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaExtension:name>DocumentType</pdfaExtension:name><pdfaExtension:value type="Text">INVOICE</pdfaExtension:value><pdfaExtension:category>external</pdfaExtension:category></rdf:li><rdf:li rdf:parseType="Resource"><pdfaExtension:name>DocumentFileName</pdfaExtension:name><pdfaExtension:value type="Text">factur-x.xml</pdfaExtension:value><pdfaExtension:category>external</pdfaExtension:category></rdf:li><rdf:li rdf:parseType="Resource"><pdfaExtension:name>Version</pdfaExtension:name><pdfaExtension:value type="Text">1.0</pdfaExtension:value><pdfaExtension:category>external</pdfaExtension:category></rdf:li></rdf:Bag></pdfaExtension:property></rdf:li></rdf:Bag></pdfaExtension:schemas><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version></rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n`;
}

/** Minimal XML escaping for the producer string. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Source PDF/A detection (the honesty input)                          */
/* ------------------------------------------------------------------ */

/**
 * Raw latin1 scan of the source bytes for a pdfaid identification
 * ("pdfaid:part" — an uncompressed XMP packet, how every mainstream
 * producer writes it). This is the honesty probe that feeds the pdfa
 * option's auto mode: NO pdfaid → claim NOTHING unless the user
 * forced it. (A source whose XMP lives inside a compressed object
 * stream scans negative — an honest under-claim, never a false one.)
 */
export function sourceHasPdfaid(bytes: Uint8Array): boolean {
  const text = latin1(bytes);
  return text.indexOf("pdfaid:part") !== -1;
}

/** Decodes bytes as latin1 (binary-safe one char per byte). */
function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x1000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The surgery                                                         */
/* ------------------------------------------------------------------ */

/** attachFacturx options. */
export interface AttachFacturxOptions {
  /** Claim PDF/A-3 identification (the caller derives it honestly). */
  claimPdfa: boolean;
  /** The sRGB ICC profile bytes — REQUIRED when claimPdfa. */
  icc?: Uint8Array | null;
  /** pdf:Producer (XMP). Default "MyCloudy". */
  producer?: string;
  /** Params / ModDate PDF date string ("D:20240115000000Z"). */
  modDate?: string;
}

/** attachFacturx result. */
export interface AttachFacturxResult {
  /** The rewritten PDF bytes (uncompressed object streams). */
  bytes: Uint8Array;
  /** Whether the pdfaid identification was written. */
  claimed: boolean;
}

/** Error thrown when a claim arrives without the ICC to back it. */
export class FacturxIccRequiredError extends Error {
  constructor() {
    super("facturx: ICC profile bytes are required to claim PDF/A");
    this.name = "FacturxIccRequiredError";
  }
}

/**
 * The whole attachment surgery. The source is loaded LENIENTLY
 * (ignoreEncryption — encrypted sources still refuse the claim
 * honestly below; updateMetadata:false — pdf-lib must not clobber
 * the XMP we are about to write). Pre-existing /Metadata, /AF and
 * /Names entries are MERGED, not clobbered.
 */
export async function attachFacturx(
  pdfBytes: Uint8Array,
  xmlBytes: Uint8Array,
  opts: AttachFacturxOptions
): Promise<AttachFacturxResult> {
  if (opts.claimPdfa === true && (!opts.icc || opts.icc.length === 0)) {
    throw new FacturxIccRequiredError();
  }

  const doc = await PDFDocument.load(pdfBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  if (doc.isEncrypted) {
    // Saving would ship a still-encrypted file — the honest refusal
    // (the repair-pdf tier-1 lesson).
    throw new Error("facturx: encrypted source");
  }

  const context = doc.context;
  const catalog = doc.catalog;
  const xmlName = "factur-x.xml";
  const producer = opts.producer ?? DEFAULT_PRODUCER;
  const modDate = opts.modDate ?? pdfDateNow();

  /* ---- 1. EmbeddedFile stream ------------------------------------ */
  const paramsDict = context.obj({
    Size: PDFNumber.of(xmlBytes.length),
    ModDate: PDFString.of(modDate),
  });
  const embeddedDict = context.obj({
    Type: PDFName.of("EmbeddedFile"),
    // PDFName.of decodes "#2F" escapes, so "text#2Fxml" IS "text/xml"
    // written with the name-escape the PDF format requires.
    Subtype: PDFName.of("text#2Fxml"),
    Params: paramsDict,
  }) as PDFDict;
  const embeddedStream = PDFRawStream.of(embeddedDict, xmlBytes);
  const embeddedRef = context.register(embeddedStream);

  /* ---- 2. Filespec ------------------------------------------------ */
  const efDict = context.obj({
    F: embeddedRef,
    UF: embeddedRef,
  });
  const filespecDict = context.obj({
    Type: PDFName.of("Filespec"),
    F: PDFString.of(xmlName),
    UF: PDFHexString.fromText(xmlName),
    Desc: PDFString.of(FILESPEC_DESC),
    EF: efDict,
    AFRelationship: PDFName.of("Data"),
  });
  const filespecRef = context.register(filespecDict);

  /* ---- 3. Catalog /AF (merge) ------------------------------------- */
  const afExisting = catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  if (afExisting !== undefined) {
    afExisting.push(filespecRef);
  } else {
    catalog.set(PDFName.of("AF"), context.obj([filespecRef]));
  }

  /* ---- 4. /Names /EmbeddedFiles (merge) --------------------------- */
  mergeEmbeddedFilesName(context, catalog, filespecRef, xmlName);

  /* ---- 5. XMP metadata stream -------------------------------------- */
  // Remove the pre-existing /Metadata first (object bytes included).
  const metaObj = catalog.get(PDFName.of("Metadata"));
  catalog.delete(PDFName.of("Metadata"));
  if (metaObj instanceof PDFRef) {
    context.delete(metaObj);
  }
  const xmpText = buildFacturxXmp(opts.claimPdfa === true, producer);
  const xmpDict = context.obj({
    Type: PDFName.of("Metadata"),
    Subtype: PDFName.of("XML"),
  }) as PDFDict;
  const xmpStream = PDFRawStream.of(xmpDict, new TextEncoder().encode(xmpText));
  catalog.set(PDFName.of("Metadata"), context.register(xmpStream));

  /* ---- 6. OutputIntent (claiming only, merged honestly) ----------- */
  if (opts.claimPdfa === true) {
    const icc = opts.icc as Uint8Array;
    const existingIntents = catalog.lookupMaybe(
      PDFName.of("OutputIntents"),
      PDFArray
    );
    const hasOwn =
      existingIntents !== undefined && existingIntents.size() > 0;
    if (!hasOwn) {
      const iccDict = context.obj({ N: PDFNumber.of(3) }) as PDFDict;
      const iccStream = PDFRawStream.of(iccDict, icc);
      const iccRef = context.register(iccStream);
      const intentDict = context.obj({
        Type: PDFName.of("OutputIntent"),
        S: PDFName.of("GTS_PDFA1"),
        OutputConditionIdentifier: PDFString.of("sRGB"),
        Info: PDFString.of("sRGB IEC61966-2.1"),
        DestOutputProfile: iccRef,
      });
      const intentRef = context.register(intentDict);
      catalog.set(PDFName.of("OutputIntents"), context.obj([intentRef]));
    }
    // Source OutputIntents kept as-is: the source's own profile backs
    // the claim better than a swapped-in one would.
  }

  // Uncompressed object streams: every object stays a plain indirect
  // object — raw-byte scans and the widest validator compatibility.
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, claimed: opts.claimPdfa === true };
}

/**
 * Appends [ <hex name>, filespecRef ] into the catalog's
 * /Names /EmbeddedFiles tree — merging into the existing flat Names
 * array (following /Kids to the first leaf when the tree is split),
 * creating the node when absent, and preserving every other /Names
 * key (Dests, JavaScript…). Entries land at the end of the array:
 * strict binary-search name-tree lookups should use /AF (which the
 * Factur-X identification itself keys on); pdf.js's getAll() walks
 * flat arrays regardless of order.
 */
function mergeEmbeddedFilesName(
  context: { obj(value: unknown): PDFObject; lookup(ref: unknown): unknown },
  catalog: PDFDict,
  filespecRef: PDFRef,
  xmlName: string
): void {
  const pair: [PDFHexString, PDFRef] = [
    PDFHexString.fromText(xmlName),
    filespecRef,
  ];

  const namesDict = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  if (namesDict === undefined) {
    // No /Names at all — create the whole branch.
    catalog.set(
      PDFName.of("Names"),
      context.obj({
        EmbeddedFiles: { Names: context.obj([pair[0], pair[1]]) },
      })
    );
    return;
  }

  let node: PDFDict | undefined = namesDict.lookupMaybe(
    PDFName.of("EmbeddedFiles"),
    PDFDict
  );
  // A split tree: follow /Kids to the first leaf carrying /Names.
  let depth = 0;
  while (
    node !== undefined &&
    node.lookupMaybe(PDFName.of("Names"), PDFArray) === undefined &&
    depth < 5
  ) {
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids === undefined || kids.size() === 0) break;
    const first = kids.lookup(0);
    const firstDict = resolveDict(context, first);
    if (firstDict === undefined) break;
    node = firstDict;
    depth += 1;
  }

  if (node === undefined) {
    namesDict.set(
      PDFName.of("EmbeddedFiles"),
      context.obj({ Names: context.obj([pair[0], pair[1]]) })
    );
    return;
  }

  const namesArray = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (namesArray === undefined) {
    node.set(PDFName.of("Names"), context.obj([pair[0], pair[1]]));
    return;
  }
  namesArray.push(pair[0]);
  namesArray.push(pair[1]);
}

/** Resolves a ref-or-direct value into a PDFDict (best effort). */
function resolveDict(
  context: { lookup(ref: unknown): unknown },
  value: PDFObject | PDFRef | undefined
): PDFDict | undefined {
  if (value === undefined) return undefined;
  if (value instanceof PDFDict) return value;
  const resolved = context.lookup(value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

/** Formats "now" as a PDF date string (D:YYYYMMDDHHmmSSZ). */
function pdfDateNow(): string {
  const d = new Date();
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(
    d.getUTCDate()
  )}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
