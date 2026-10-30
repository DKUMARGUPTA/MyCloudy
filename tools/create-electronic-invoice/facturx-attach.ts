import {
  catalogDict,
  newDict,
  pdfInfoText,
  resolveTrailerRef,
  rewriteDocument,
  arrItems,
  dget,
  asName,
  asNum,
  asDict,
  asArr,
  newref,
  ref,
  num,
  name,
  dict as pdfDict,
  arr as pdfArr,
  PdfError,
  parsePdf,
  type PdfObj,
  type ParsedPdf,
} from "@/lib/own/pdf";

/**
 * Factur-X attachment surgery (Task b6-c) — PURE own-engine low-level
 * object writing (the bookmark-pdf / meta-common precedents), no browser
 * APIs: the same code runs in the tool workers and under bun in the
 * smokes.
 *
 * What attachFacturx does to the source catalog, per the Factur-X
 * (FNFE-MFE) attachment structure:
 *
 *   1. EmbeddedFile stream — new object { Type /EmbeddedFile,
 *      Subtype /text#2Fxml (that IS how "text/xml" is written in a PDF
 *      name — the "#2F" name escape), Params { Size, ModDate } } as an
 *      extraObject above the source numbering.
 *   2. Filespec dict — { Type /Filespec, F "factur-x.xml" (literal),
 *      UF <FEFF…> (UTF-16BE hex), Desc, EF { F <stream>, UF <stream> },
 *      AFRelationship /Alternative } — ONE pass: the legacy build needed
 *      a second reload+patch stage because its attach() omitted
 *      /AFRelationship; here the dict is authored complete.
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
 *      file cannot back. A pre-existing /Metadata stream is dropped
 *      object-level (rewriteDocument deletions — remove-pdf-metadata
 *      precedent).
 *   6. OutputIntent — ONLY when claiming PDF/A: { S /GTS_PDFA1,
 *      OutputConditionIdentifier "sRGB", DestOutputProfile <ICC stream> }.
 *      When the source already carries OutputIntents they are kept
 *      untouched (the source's own profile backs the claim); the ICC
 *      stream is { N 3 } + the raw profile bytes.
 *
 * The rewrite runs CLASSIC (no ObjStm — useObjectStreams:false parity):
 * Factur-X readers had issues with attachments + XMP inside compressed
 * containers, so every object stays loose.
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
  /**
   * Replace the default Factur-X XMP packet with a caller-authored one
   * (the create-electronic-invoice worker's buildXmpPacket — same
   * surgery, different identification vocabulary).
   */
  xmpOverride?: string;
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
 * The whole attachment surgery (own engine, ONE pass). The source is
 * parsed strictly (a trailer /Encrypt refuses with the typed "encrypted"
 * PdfError — the honest refusal, the repair-pdf tier-1 lesson).
 * Pre-existing /AF and /Names entries are MERGED, not clobbered; a
 * pre-existing /Metadata stream is deleted object-level.
 */
export async function attachFacturx(
  pdfBytes: Uint8Array,
  xmlBytes: Uint8Array,
  opts: AttachFacturxOptions
): Promise<AttachFacturxResult> {
  if (opts.claimPdfa === true && (!opts.icc || opts.icc.length === 0)) {
    throw new FacturxIccRequiredError();
  }

  const doc = parsePdf(pdfBytes);
  const catalog = catalogDict(doc);
  if (catalog === null) {
    throw new PdfError("corrupt", "facturx: source has no catalog");
  }
  const xmlName = "factur-x.xml";
  const producer = opts.producer ?? DEFAULT_PRODUCER;
  const modDate = opts.modDate ?? pdfDateNow();

  /* ---- numbering: extras ride ABOVE the source table --------------- */
  let nextNum = 0;
  for (const numKey of doc.entries.keys()) nextNum = Math.max(nextNum, numKey);
  nextNum += 1;
  const extras: Array<{ num: number; obj: PdfObj }> = [];

  /* ---- 1. EmbeddedFile stream -------------------------------------- */
  const embeddedNum = nextNum++;
  const embeddedStream: PdfObj = {
    k: "stream",
    m: new Map<string, PdfObj>([
      ["Type", name("EmbeddedFile")],
      // The engine's name writer escapes "/" → "#2F", so the DECODED form
      // "text/xml" serializes as /text#2Fxml — the name-escape the PDF
      // format requires (the legacy writer's raw-name-form parity).
      ["Subtype", name("text/xml")],
      [
        "Params",
        newDict([
          ["Size", num(xmlBytes.length)],
          ["ModDate", { k: "lstr", b: latin1Bytes(modDate) }],
        ]),
      ],
    ]),
    raw: xmlBytes,
  };
  extras.push({ num: embeddedNum, obj: embeddedStream });

  /* ---- 2. Filespec (complete — /AFRelationship authored directly) --- */
  const filespecNum = nextNum++;
  const filespecDict = newDict([
    ["Type", name("Filespec")],
    ["F", { k: "lstr", b: latin1Bytes(xmlName) }],
    ["UF", pdfInfoText(xmlName)],
    ["Desc", { k: "lstr", b: latin1Bytes(FILESPEC_DESC) }],
    [
      "EF",
      newDict([
        ["F", ref(embeddedNum)],
        ["UF", ref(embeddedNum)],
      ]),
    ],
    ["AFRelationship", name("Alternative")],
  ]);
  extras.push({ num: filespecNum, obj: filespecDict });
  const filespecRef = ref(filespecNum);

  /* ---- 3. Catalog /AF (merge) -------------------------------------- */
  const afExisting = asArr(catalog.get("AF"));
  if (afExisting !== undefined) {
    afExisting.push(filespecRef);
  } else {
    catalog.set("AF", pdfArr(filespecRef));
  }

  /* ---- 4. /Names /EmbeddedFiles (merge) ---------------------------- */
  mergeEmbeddedFilesName(doc, catalog, filespecRef, xmlName);

  /* ---- 5. XMP metadata stream -------------------------------------- */
  const deletions = new Set<number>();
  const oldMeta = catalog.get("Metadata");
  const oldMetaRef = oldMeta && oldMeta.k === "ref" ? oldMeta : null;
  const xmpText = opts.xmpOverride ?? buildFacturxXmp(opts.claimPdfa === true, producer);
  const xmpNum = nextNum++;
  const xmpStream: PdfObj = {
    k: "stream",
    m: new Map<string, PdfObj>([
      ["Type", name("Metadata")],
      ["Subtype", name("XML")],
    ]),
    raw: new TextEncoder().encode(xmpText),
  };
  extras.push({ num: xmpNum, obj: xmpStream });
  catalog.set("Metadata", ref(xmpNum));
  if (oldMetaRef !== null) deletions.add(oldMetaRef.num);

  /* ---- 6. OutputIntent (claiming only, merged honestly) ------------ */
  if (opts.claimPdfa === true) {
    const icc = opts.icc as Uint8Array;
    const existingIntents = resolveTrailerRef(
      doc,
      catalog.get("OutputIntents")
    );
    const intentArr = existingIntents && existingIntents.k === "arr" ? existingIntents.items : undefined;
    const hasOwn = intentArr !== undefined && intentArr.length > 0;
    if (!hasOwn) {
      const iccNum = nextNum++;
      const iccStream: PdfObj = {
        k: "stream",
        m: new Map<string, PdfObj>([["N", num(3)]]),
        raw: icc,
      };
      extras.push({ num: iccNum, obj: iccStream });
      const intentNum = nextNum++;
      const intentDict = newDict([
        ["Type", name("OutputIntent")],
        ["S", name("GTS_PDFA1")],
        ["OutputConditionIdentifier", { k: "lstr", b: latin1Bytes("sRGB") }],
        ["Info", { k: "lstr", b: latin1Bytes("sRGB IEC61966-2.1") }],
        ["DestOutputProfile", ref(iccNum)],
      ]);
      extras.push({ num: intentNum, obj: intentDict });
      catalog.set("OutputIntents", pdfArr(ref(intentNum)));
    }
    // Source OutputIntents kept as-is: the source's own profile backs
    // the claim better than a swapped-in one would.
  }

  // CLASSIC output (no ObjStm — useObjectStreams:false parity): every
  // object stays a plain indirect object — raw-byte scans and the widest
  // validator compatibility.
  const bytes = rewriteDocument(doc, { extraObjects: extras, deletions });
  return { bytes, claimed: opts.claimPdfa === true };
}

/** UTF-8 → latin1-ish bytes for literal strings (ASCII names/dates only). */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
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
  doc: ParsedPdf,
  catalog: Map<string, PdfObj>,
  filespecRef: PdfObj,
  xmlName: string
): void {
  const pair = pdfArr(pdfInfoText(xmlName), filespecRef);

  const namesValue = catalog.get("Names");
  const namesDictRaw = resolveTrailerRef(doc, namesValue);
  if (namesDictRaw === undefined || namesDictRaw.k !== "dict") {
    // No /Names at all — create the whole branch.
    catalog.set(
      "Names",
      newDict([["EmbeddedFiles", newDict([["Names", pair]])]])
    );
    return;
  }

  let node: Map<string, PdfObj> | undefined = asDict(
    resolveTrailerRef(doc, namesDictRaw.m.get("EmbeddedFiles"))
  );
  // A split tree: follow /Kids to the first leaf carrying /Names.
  let depth = 0;
  while (
    node !== undefined &&
    asArr(resolveTrailerRef(doc, node.get("Names"))) === undefined &&
    depth < 5
  ) {
    const kids = asArr(resolveTrailerRef(doc, node.get("Kids")));
    if (kids === undefined || kids.length === 0) break;
    const firstDict = asDict(resolveTrailerRef(doc, kids[0]));
    if (firstDict === undefined) break;
    node = firstDict;
    depth += 1;
  }

  if (node === undefined) {
    namesDictRaw.m.set(
      "EmbeddedFiles",
      newDict([["Names", pair]])
    );
    return;
  }

  const namesArray = asArr(resolveTrailerRef(doc, node.get("Names")));
  if (namesArray === undefined) {
    node.set("Names", pair);
    return;
  }
  namesArray.push(pdfInfoText(xmlName));
  namesArray.push(filespecRef);
}

/** Formats "now" as a PDF date string (D:YYYYMMDDHHmmSSZ). */
function pdfDateNow(): string {
  const d = new Date();
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(
    d.getUTCDate()
  )}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
