import type { LucideIcon } from "lucide-react";
import {
  AlignLeft,
  ArrowRightLeft,
  ArrowUpDown,
  Award,
  BadgeCheck,
  Blend,
  Bookmark,
  BookOpen,
  BrainCircuit,
  Braces,
  ClipboardCheck,
  ClipboardCopy,
  Code,
  Combine,
  Contact,
  Contrast,
  Copy,
  Crop,
  DraftingCompass,
  Droplets,
  Eye,
  EyeOff,
  FileArchive,
  FileCheck,
  FileCode,
  FileImage,
  FileInput,
  FileMinus,
  FileOutput,
  FilePlus,
  FileSearch,
  FileSpreadsheet,
  FileText,
  FileType,
  FileX,
  Files,
  FormInput,
  Gauge,
  Gift,
  GitCompare,
  Globe,
  Hash,
  Image,
  ImagePlus,
  Images,
  Info,
  KeyRound,
  Languages,
  LayoutGrid,
  LayoutTemplate,
  ListChecks,
  ListOrdered,
  Lock,
  Minimize2,
  MessageSquare,
  MessageSquareOff,
  Newspaper,
  Palette,
  PanelTop,
  PenLine,
  PenTool,
  Pencil,
  Presentation,
  QrCode,
  Receipt,
  RotateCw,
  Ruler,
  Scaling,
  ScanLine,
  ScanText,
  Scissors,
  Send,
  Settings2,
  Shapes,
  ShieldCheck,
  Search,
  Split,
  SquareStack,
  Target,
  UserCog,
  Wrench,
  Zap,
} from "lucide-react";
/**
 * DocoPDF tool registry — THE source of truth for every tool (PRD §7).
 *
 * One config object per tool: id (== URL slug), category, mode D/S, roadmap
 * phase, icon, localized name/description (en + hi), search tags (en + hi),
 * accepted input type, curated popularity, and the `enabled` flag that flips
 * to true when the tool ships (Phases 2+). The shared ToolShell renders every
 * enabled tool from this registry — no per-tool pages are hand-written.
 *
 * NOTE on i18n: tool catalog strings live HERE as typed locale maps (not in
 * en.json/hi.json). This keeps the catalog a single source of truth and makes
 * a missing Hindi string a type error. UI chrome strings stay in the JSON
 * catalogs. Deploying with path locales (/hi) reads the same maps.
 */

export type ToolMode = "D" | "S";
export type RoadmapPhase = "P1" | "P2" | "P3";

export type ToolCategoryId =
  | "organize"
  | "edit"
  | "convert-to"
  | "convert-from"
  | "security"
  | "optimize"
  | "create"
  | "invoices"
  | "view"
  | "images";

export type Accepts =
  | "pdf"
  | "image"
  | "word"
  | "office"
  | "text"
  | "url"
  | "any";

export interface L10n {
  en: string;
  hi: string;
}

export type CategoryColor =
  | "organize"
  | "edit"
  | "convert"
  | "security"
  | "optimize"
  | "create"
  | "invoices"
  | "view";

export interface ToolCategory {
  id: ToolCategoryId;
  name: L10n;
  /** Detailed intro for the category view (PRD §6.2). */
  intro: L10n;
  color: CategoryColor;
  icon: LucideIcon;
}

export interface ToolDef {
  id: string;
  category: ToolCategoryId;
  mode: ToolMode;
  phase: RoadmapPhase;
  icon: LucideIcon;
  name: L10n;
  description: L10n;
  tags: { en: string[]; hi: string[] };
  accepts: Accepts;
  /** Curated 0-100; drives "Popular" sorting and quick tools. */
  popularity: number;
  /** True once the tool is live (flipped per PRD phase plan). */
  enabled: boolean;
  pro: boolean;
  /**
   * AI-dependent tool (R22): the run pipeline calls a server AI route
   * (/api/chat | /api/summarize | /api/translate) whose backend model
   * needs a configured provider. R23 (owner decision): these tools are
   * DEFERRED — enabled:false, phase P3 — until the AI backend goes live
   * in a future phase. The flag is kept so the future re-enable round
   * can restore the warning UI (banner + chips) while stabilising.
   */
  aiDependent?: boolean;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export const CATEGORIES: ToolCategory[] = [
  {
    id: "organize",
    color: "organize",
    icon: LayoutGrid,
    name: { en: "Organize", hi: "व्यवस्थित करें" },
    intro: {
      en: "Combine files, split them into parts, reorder, rotate or extract exactly the pages you need. All organizing happens on your device — even 100-page documents stay quick.",
      hi: "फ़ाइलें जोड़ें, बाँटें, क्रम बदलें, पेज घुमाएँ या ज़रूरी पेज निकालें। सारा काम आपके डिवाइस पर होता है — 100 पेज के दस्तावेज़ भी तेज़ चलते हैं।",
    },
  },
  {
    id: "edit",
    color: "edit",
    icon: PenLine,
    name: { en: "Edit", hi: "संपादित करें" },
    intro: {
      en: "A full editor plus quick edits: watermarks, page numbers, headers, crop and metadata. Change what you need without uploading anything.",
      hi: "पूरा एडिटर और साथ में झटपट बदलाव: वॉटरमार्क, पेज नंबर, हेडर-फुटर, क्रॉप और मेटाडेटा। कुछ भी अपलोड किए बिना बदलें।",
    },
  },
  {
    id: "convert-to",
    color: "convert",
    icon: FileInput,
    name: { en: "Convert to PDF", hi: "PDF बनाएँ" },
    intro: {
      en: "Turn Word, images, text or any other file into clean PDFs. Office conversions use server processing; images and text convert fully on your device.",
      hi: "वर्ड, तस्वीरें, टेक्स्ट या कोई भी फ़ाइल साफ़ PDF में बदलें। ऑफ़िस फ़ाइलों का रूपांतरण सर्वर पर होता है; तस्वीरें और टेक्स्ट पूरी तरह डिवाइस पर।",
    },
  },
  {
    id: "convert-from",
    color: "convert",
    icon: FileOutput,
    name: { en: "Convert from PDF", hi: "PDF से बदलें" },
    intro: {
      en: "Extract your PDF into JPG or PNG images, plain text, or editable Office formats. Device tools give instant results; Office exports use the server.",
      hi: "अपनी PDF को JPG/PNG तस्वीरों, सादे टेक्स्ट या एडिट करने योग्य ऑफ़िस फ़ॉर्मैट में बदलें। डिवाइस टूल तुरंत नतीजा देते हैं; ऑफ़िस एक्सपोर्ट सर्वर से।",
    },
  },
  {
    id: "security",
    color: "security",
    icon: ShieldCheck,
    name: { en: "Security", hi: "सुरक्षा" },
    intro: {
      en: "Password-protect, unlock your own files, sign, redact sensitive details and strip metadata — with honest badges showing where each job runs.",
      hi: "पासवर्ड लगाएँ, अपनी फ़ाइलें अनलॉक करें, हस्ताक्षर करें, संवेदनशील जानकारी छिपाएँ और मेटाडेटा हटाएँ — हर टूल पर ईमानदार बैज के साथ।",
    },
  },
  {
    id: "optimize",
    color: "optimize",
    icon: Gauge,
    name: { en: "Optimize", hi: "ऑप्टिमाइज़" },
    intro: {
      en: "Shrink PDFs for email or form portals, add searchable text with OCR, repair damaged files and flatten forms — right in the browser.",
      hi: "ईमेल या फ़ॉर्म पोर्टल के लिए PDF छोटी करें, OCR से खोजने योग्य टेक्स्ट जोड़ें, ख़राब फ़ाइलें ठीक करें और फ़ॉर्म फ़्लैटन करें — सब ब्राउज़र में।",
    },
  },
  {
    id: "create",
    color: "create",
    icon: FilePlus,
    name: { en: "Create", hi: "बनाएँ" },
    intro: {
      en: "Start from scratch: write documents, scan paper with your camera, build QR codes or resumes — and export finished PDFs.",
      hi: "शुरुआत से बनाएँ: दस्तावेज़ लिखें, कैमरे से स्कैन करें, QR कोड या रिज़्यूमे बनाएँ — और तैयार PDF एक्सपोर्ट करें।",
    },
  },
  {
    id: "invoices",
    color: "invoices",
    icon: Receipt,
    name: { en: "Invoices", hi: "इनवॉइस" },
    intro: {
      en: "India-ready GST invoices with automatic CGST/SGST/IGST splits, amount in words and UPI QR — plus e-invoice formats for EU business.",
      hi: "भारत के लिए GST इनवॉइस — CGST/SGST/IGST का अपने आप हिसाब, शब्दों में रक़म और UPI QR — साथ में EU के ई-इनवॉइस फ़ॉर्मैट।",
    },
  },
  {
    id: "view",
    color: "view",
    icon: Eye,
    name: { en: "View", hi: "देखें" },
    intro: {
      en: "Read, search and verify: a fast viewer, multi-file search, side-by-side comparison and signature checks — no upload needed.",
      hi: "पढ़ें, खोजें और जाँचें: तेज़ व्यूअर, कई फ़ाइलों में खोज, साथ-साथ तुलना और हस्ताक्षर जाँच — बिना अपलोड।",
    },
  },
  {
    id: "images",
    color: "convert",
    icon: Image,
    name: { en: "Image tools", hi: "तस्वीर टूल" },
    intro: {
      en: "Convert phone photos between HEIC, WEBP, JPG and PNG, resize to exact KB limits for government forms, and make passport photo sheets.",
      hi: "फ़ोन की तस्वीरें HEIC, WEBP, JPG और PNG में बदलें, सरकारी फ़ॉर्म के लिए तय KB तक छोटी करें और पासपोर्ट फ़ोटो शीट बनाएँ।",
    },
  },
];

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

type ToolSpec = Omit<ToolDef, "enabled" | "pro"> & {
  enabled?: boolean;
  pro?: boolean;
};

const def = (spec: ToolSpec): ToolDef => ({
  enabled: false,
  pro: false,
  ...spec,
});

export const ALL_TOOLS: ToolDef[] = [
  /* ---------------- Organize (§7.1) ---------------- */
  def({
    id: "merge-pdf",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: Combine,
    popularity: 100,
    accepts: "pdf",
    enabled: true,
    name: { en: "Merge PDF", hi: "पीडीएफ़ जोड़ें" },
    description: {
      en: "Combine up to 50 PDFs into one, reorder files, pick page ranges.",
      hi: "50 तक PDF एक में जोड़ें, क्रम बदलें, पेज चुनें।",
    },
    tags: {
      en: ["combine", "join", "merge files"],
      hi: ["जोड़ना", "मिलाना", "jodein", "jodna"],
    },
  }),
  def({
    id: "split-pdf",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: Split,
    popularity: 95,
    accepts: "pdf",
    enabled: true,
    name: { en: "Split PDF", hi: "पीडीएफ़ बाँटें" },
    description: {
      en: "Split by ranges, every N pages, bookmarks, size or visually.",
      hi: "रेंज, हर N पेज, बुकमार्क या साइज़ से बाँटें।",
    },
    tags: {
      en: ["divide", "separate", "cut pdf"],
      hi: ["बाँटना", "तोड़ना", "baantein", "todna"],
    },
  }),
  def({
    id: "rotate-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: RotateCw,
    popularity: 68,
    accepts: "pdf",
    enabled: true,
    name: { en: "Rotate PDF pages", hi: "पेज घुमाएँ" },
    description: {
      en: "Turn all or selected pages 90° left or right, sideways scans fixed.",
      hi: "सभी या चुने पेज 90° घुमाएँ, तिरछे स्कैन ठीक करें।",
    },
    tags: {
      en: ["turn", "landscape", "portrait"],
      hi: ["घुमाना", "sideways", "ghumaye"],
    },
  }),
  def({
    id: "rearrange-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: ArrowUpDown,
    popularity: 45,
    accepts: "pdf",
    enabled: true,
    name: { en: "Rearrange PDF pages", hi: "पेज क्रम बदलें" },
    description: {
      en: "Drag thumbnails to a new order, with keyboard move buttons.",
      hi: "थंबनेल खींचकर क्रम बदलें, कीबोर्ड बटन भी।",
    },
    tags: {
      en: ["reorder", "sort pages", "move pages"],
      hi: ["क्रम", "order", "kram badlein"],
    },
  }),
  def({
    id: "remove-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: FileMinus,
    popularity: 42,
    accepts: "pdf",
    enabled: true,
    name: { en: "Remove PDF pages", hi: "पेज हटाएँ" },
    description: {
      en: "Delete unwanted pages by selection, list or auto blank-page detect.",
      hi: "चुनकर, सूची से या ख़ाली पेज पहचान कर हटाएँ।",
    },
    tags: {
      en: ["delete pages", "blank pages"],
      hi: ["हटाना", "delete", "hataye"],
    },
  }),
  def({
    id: "extract-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P1",
    icon: FileOutput,
    popularity: 40,
    accepts: "pdf",
    enabled: true,
    name: { en: "Extract PDF pages", hi: "पेज निकालें" },
    description: {
      en: "Build a new PDF from selected pages, or one file per page.",
      hi: "चुने पेजों की नई PDF बनाएँ, या हर पेज अलग फ़ाइल।",
    },
    tags: {
      en: ["take out", "separate pages"],
      hi: ["निकालना", "extract", "nikalein"],
    },
  }),
  def({
    id: "assemble-pdf",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: Copy,
    popularity: 20,
    accepts: "pdf",
    enabled: true,
    name: { en: "Assemble PDF", hi: "पेज इकट्ठा करें" },
    description: {
      en: "Multi-document workspace: drag pages between files, zipper merge.",
      hi: "कई दस्तावेज़ एक साथ: पेज खींचकर शेयर करें।",
    },
    tags: {
      en: ["multi document", "zipper merge", "interleave"],
      hi: ["इकट्ठा", "assemble", "ikatta"],
    },
  }),
  def({
    id: "pages-per-sheet",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: LayoutGrid,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Pages per sheet (N-up)", hi: "एक शीट में कई पेज" },
    description: {
      en: "Place 2, 4, 6, 9 or 16 pages on one sheet with live preview.",
      hi: "2, 4, 6, 9 या 16 पेज एक शीट पर, लाइव प्रीव्यू के साथ।",
    },
    tags: { en: ["n-up", "booklet", "grid"], hi: ["n-up", "grid", "sheet"] },
  }),
  def({
    id: "halve-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: Scissors,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Halve PDF pages", hi: "पेज आधे करें" },
    description: {
      en: "Cut scanned book spreads into left/right single pages.",
      hi: "स्कैन की किताब के पेज बाएँ/दाएँ आधे करें।",
    },
    tags: { en: ["book scan", "split page"], hi: ["आधा", "book scan"] },
  }),
  def({
    id: "reverse-pdf-pages",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: ArrowUpDown,
    popularity: 22,
    accepts: "pdf",
    enabled: true,
    name: { en: "Reverse pages", hi: "पेज उल्टे करें" },
    description: {
      en: "Flip the whole reading order — last page first, one tap.",
      hi: "पूरा क्रम उल्टा — आख़िरी पेज पहले, एक टैप।",
    },
    tags: {
      en: ["reverse order", "flip pages", "backwards"],
      hi: ["उल्टा", "reverse", "ulta"],
    },
  }),
  def({
    id: "duplex-collate",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: ArrowRightLeft,
    popularity: 24,
    accepts: "pdf",
    enabled: true,
    name: { en: "Duplex collate", hi: "डुप्लेक्स कोलेट" },
    description: {
      en: "Two-block duplex scan (fronts then backs) back into 1, 2, 3 order.",
      hi: "दो-हिस्सों वाला डुप्लेक्स स्कैन (पहले अगले, फिर पिछले) वापस 1, 2, 3 क्रम में।",
    },
    tags: {
      en: ["duplex scan", "collate pages", "double sided scan fix"],
      hi: ["डुप्लेक्स स्कैन", "duplex", "collate"],
    },
  }),
  def({
    id: "add-blank-page",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: FilePlus,
    popularity: 20,
    accepts: "pdf",
    enabled: true,
    name: { en: "Add blank page", hi: "ख़ाली पेज जोड़ें" },
    description: {
      en: "Insert empty pages at the start, end or anywhere — matching size.",
      hi: "शुरुआत, अंत या बीच में ख़ाली पेज — मिलते-जुलते साइज़ के।",
    },
    tags: {
      en: ["insert blank", "empty page", "add page"],
      hi: ["ख़ाली पेज", "blank", "khaali"],
    },
  }),
  def({
    id: "divide-page",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: Split,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Divide page", hi: "पेज तोड़ें" },
    description: {
      en: "Cut pages into 2–4 columns, rows or a grid — content stays sharp.",
      hi: "पेज 2–4 कॉलम, पंक्ति या ग्रिड में काटें — कंटेंट तेज़ रहता है।",
    },
    tags: {
      en: ["split page", "grid cut", "columns"],
      hi: ["काटें", "divide", "tukde"],
    },
  }),
  def({
    id: "combine-single-page",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: SquareStack,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Combine to single page", hi: "एक पेज में जोड़ें" },
    description: {
      en: "Stitch every page into one long scroll — vertical or horizontal.",
      hi: "सारे पेज एक लंबे स्क्रॉल में — खड़ा या आड़ा।",
    },
    tags: {
      en: ["single page", "stitch", "long image"],
      hi: ["एक पेज", "जोड़ें", "scroll"],
    },
  }),
  def({
    id: "booklet-pdf",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: BookOpen,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Booklet PDF", hi: "बुकलेट बनाएँ" },
    description: {
      en: "Saddle-stitch order: print duplex, fold, staple — instant booklet.",
      hi: "फोल्ड-स्टेपल क्रम: दोतरफ़ा प्रिंट, मोड़ें, स्टेपल — तुरंत बुकलेट।",
    },
    tags: {
      en: ["booklet", "saddle stitch", "fold print"],
      hi: ["बुकलेट", "booklet", "fold"],
    },
  }),
  def({
    id: "bookmark-pdf",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: Bookmark,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Bookmark PDF", hi: "बुकमार्क जोड़ें" },
    description: {
      en: "Add, rename and nest an outline tree for easy navigation.",
      hi: "आउटलाइन ट्री जोड़ें, नाम बदलें, क्रम बनाएँ।",
    },
    tags: { en: ["outline", "table of contents"], hi: ["बुकमार्क", "outline"] },
  }),
  def({
    id: "extract-images",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: Images,
    popularity: 22,
    accepts: "pdf",
    enabled: true,
    name: { en: "Extract PDF images", hi: "तस्वीरें निकालें" },
    description: {
      en: "Pull every embedded image out as PNG or JPG, ZIP download.",
      hi: "सभी जुड़ी तस्वीरें PNG/JPG में निकालें, ZIP डाउनलोड।",
    },
    tags: {
      en: ["save images", "photos from pdf"],
      hi: ["तस्वीर", "photo", "nikalein"],
    },
  }),
  def({
    id: "copy-from-pdf",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: ClipboardCopy,
    popularity: 24,
    accepts: "pdf",
    enabled: true,
    name: { en: "Copy from PDF", hi: "पीडीएफ़ से कॉपी करें" },
    description: {
      en: "Select paragraphs, tables or pictures; copy as text, Markdown or CSV.",
      hi: "पैराग्राफ़, टेबल चुनें; टेक्स्ट, Markdown या CSV में कॉपी करें।",
    },
    tags: {
      en: ["copy text", "copy table", "clipboard"],
      hi: ["कॉपी", "copy", "table"],
    },
  }),

  /* ---------------- Edit (§7.2) ---------------- */
  def({
    id: "edit-pdf",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: PenLine,
    popularity: 90,
    accepts: "pdf",
    enabled: true,
    name: { en: "Edit PDF", hi: "पीडीएफ़ एडिट करें" },
    description: {
      en: "Word-style editor: text, images, shapes, whiteout and annotations.",
      hi: "वर्ड जैसा एडिटर: टेक्स्ट, तस्वीर, आकृति, मिटाना और टिप्पणी।",
    },
    tags: {
      en: ["editor", "word like", "modify"],
      hi: ["एडिटर", "editor", "badalna"],
    },
  }),
  def({
    id: "annotate-pdf",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: MessageSquare,
    popularity: 25,
    accepts: "pdf",
    enabled: true,
    name: { en: "Annotate PDF", hi: "टिप्पणी करें" },
    description: {
      en: "Highlights, underlines, sticky notes and comments that stick.",
      hi: "हाइलाइट, अंडरलाइन, स्टिकी नोट और टिप्पणियाँ।",
    },
    tags: { en: ["comment", "highlight", "review"], hi: ["टिप्पणी", "highlight"] },
  }),
  def({
    id: "fill-out-pdf",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: ClipboardCheck,
    popularity: 50,
    accepts: "pdf",
    enabled: true,
    name: { en: "Fill out PDF forms", hi: "फ़ॉर्म भरें" },
    description: {
      en: "Fill text fields, checkboxes and dropdowns; flatten when done.",
      hi: "टेक्स्ट, चेकबॉक्स भरें; काम पूरा होने पर फ़्लैटन करें।",
    },
    tags: {
      en: ["form filling", "application form"],
      hi: ["फ़ॉर्म", "form", "bharein"],
    },
  }),
  def({
    id: "make-pdf-fillable",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: ListChecks,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Make PDF fillable", hi: "पीडीएफ़ को भरने योग्य बनाएँ" },
    description: {
      en: "Auto-detect form fields or add your own text boxes and checkboxes.",
      hi: "फ़ील्ड अपने आप पहचानें या ख़ुद टेक्स्ट बॉक्स जोड़ें।",
    },
    tags: { en: ["form fields", "acroform"], hi: ["फ़ॉर्म", "fillable"] },
  }),
  def({
    id: "add-watermark",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: Droplets,
    popularity: 55,
    accepts: "pdf",
    enabled: true,
    name: { en: "Add watermark", hi: "वॉटरमार्क लगाएँ" },
    description: {
      en: "Text or logo watermark: opacity, rotation, tiling, all pages or some.",
      hi: "टेक्स्ट या लोगो वॉटरमार्क: ओपैसिटी, झुकाव, सभी या कुछ पेज।",
    },
    tags: {
      en: ["stamp", "logo overlay", "copyright"],
      hi: ["वॉटरमार्क", "watermark", "chhaap"],
    },
  }),
  def({
    id: "add-page-numbers",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: ListOrdered,
    popularity: 38,
    accepts: "pdf",
    enabled: true,
    name: { en: "Add page numbers", hi: "पेज नंबर लगाएँ" },
    description: {
      en: "1, Page 1 of N, Roman or Hindi digits, 9 positions, skip first page.",
      hi: "1, Page 1 of N, रोमन या हिंदी अंक, 9 जगह, पहला पेज छोड़ें।",
    },
    tags: {
      en: ["numbering", "pagination"],
      hi: ["नंबर", "number", "ank"],
    },
  }),
  def({
    id: "add-header-footer",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: PanelTop,
    popularity: 30,
    accepts: "pdf",
    enabled: true,
    name: { en: "Header & footer", hi: "हेडर-फुटर लगाएँ" },
    description: {
      en: "Left/center/right text with {page}, {date}, {filename} variables.",
      hi: "बाएँ/बीच/दाएँ टेक्स्ट, {page}, {date} वेरिएबल के साथ।",
    },
    tags: { en: ["header", "footer", "running text"], hi: ["हेडर", "फुटर"] },
  }),
  def({
    id: "overlay-pdf",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: SquareStack,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Overlay PDF", hi: "ओवरले पीडीएफ़" },
    description: {
      en: "Stamp one PDF over another: position, opacity, page mapping.",
      hi: "एक PDF दूसरी पर चढ़ाएँ: जगह, ओपैसिटी, पेज मैपिंग।",
    },
    tags: { en: ["stamp", "overlay", "merge layers"], hi: ["ओवरले", "overlay"] },
  }),
  def({
    id: "crop-pdf",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: Crop,
    popularity: 34,
    accepts: "pdf",
    enabled: true,
    name: { en: "Crop PDF", hi: "क्रॉप करें" },
    description: {
      en: "Visual crop box or numeric margins, auto-detect, all or selected pages.",
      hi: "क्रॉप बॉक्स या मार्जिन नंबर, ऑटो-डिटेक्ट, सभी या चुने पेज।",
    },
    tags: { en: ["trim", "margins", "cut edges"], hi: ["क्रॉप", "crop", "trim"] },
  }),
  def({
    id: "change-pdf-page-size",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: Ruler,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Change PDF page size", hi: "पेज साइज़ बदलें" },
    description: {
      en: "A3/A4/A5/Letter/Legal or custom mm; fit, fill or keep content scale.",
      hi: "A3/A4/A5/Letter/Legal या कस्टम mm; फ़िट, फ़िल या वैसा ही।",
    },
    tags: { en: ["resize pages", "a4", "letter"], hi: ["साइज़", "a4", "letter"] },
  }),
  def({
    id: "change-pdf-doc-info",
    category: "edit",
    mode: "D",
    phase: "P1",
    icon: Info,
    popularity: 20,
    accepts: "pdf",
    enabled: true,
    name: { en: "Change document information", hi: "जानकारी बदलें" },
    description: {
      en: "Edit title, author, subject, keywords — or clear everything.",
      hi: "टाइटल, लेखक, विषय बदलें — या सब मिटाएँ।",
    },
    tags: {
      en: ["metadata", "properties", "author"],
      hi: ["जानकारी", "metadata", "info"],
    },
  }),

  /* ---------------- Create (§7.3) ---------------- */
  def({
    id: "create-pdf",
    category: "create",
    mode: "D",
    phase: "P2",
    icon: FilePlus,
    popularity: 28,
    accepts: "any",
    enabled: true,
    name: { en: "Create PDF", hi: "पीडीएफ़ बनाएँ" },
    description: {
      en: "Ready-made paper: blank, ruled, grid, dot grid, Cornell notes, weekly planner.",
      hi: "तैयार काग़ज़: ख़ाली, रूल्ड, ग्रिड, डॉट ग्रिड, कॉर्नेल नोट्स, साप्ताहिक प्लानर।",
    },
    tags: {
      en: ["new pdf", "blank", "template", "lined paper", "graph paper", "planner"],
      hi: ["नई", "बनाएँ", "टेम्पलेट", "रूल्ड", "ग्रिड", "प्लानर"],
    },
  }),
  def({
    id: "write-pdf",
    category: "create",
    mode: "D",
    phase: "P2",
    icon: Pencil,
    popularity: 26,
    accepts: "any",
    enabled: true,
    name: { en: "Write PDF", hi: "लिखकर पीडीएफ़ बनाएँ" },
    description: {
      en: "Word-processor style writing with Hindi fonts, tables and images.",
      hi: "वर्ड जैसा लेखन: हिंदी फ़ॉन्ट, टेबल और तस्वीरों के साथ।",
    },
    tags: {
      en: ["type pdf", "word processor", "letter"],
      hi: ["लिखें", "write", "khat"],
    },
  }),
  def({
    id: "scan-pdf",
    category: "create",
    mode: "D",
    phase: "P1",
    icon: ScanLine,
    popularity: 62,
    accepts: "image",
    enabled: true,
    name: { en: "Scan to PDF", hi: "स्कैन कर पीडीएफ़ बनाएँ" },
    description: {
      en: "Camera capture with edge detection, filters and multi-page scans.",
      hi: "कैमरा स्कैन: किनारा पहचान, फ़िल्टर, कई पेज एक साथ।",
    },
    tags: {
      en: ["camera", "document scanner", "photo to pdf"],
      hi: ["स्कैन", "कैमरा", "scan"],
    },
  }),
  def({
    id: "webpage-to-pdf",
    category: "create",
    mode: "D",
    phase: "P3",
    icon: Globe,
    popularity: 24,
    accepts: "url",
    enabled: true,
    name: { en: "Webpage to PDF", hi: "वेबपेज से पीडीएफ़" },
    description: {
      en: "Paste a URL and get a clean PDF of its text and structure — the server only fetches the page (never stores it); the PDF is rendered on your device.",
      hi: "URL चिपकाइए और पेज के टेक्स्ट-ढाँचे की साफ़ PDF पाइए — सर्वर सिर्फ़ पेज लाता है (सेव नहीं करता); PDF आपके डिवाइस पर बनती है।",
    },
    tags: {
      en: ["url", "save page", "print website"],
      hi: ["वेबपेज", "url", "website"],
    },
  }),
  def({
    id: "images-to-pdf",
    category: "create",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: ImagePlus,
    popularity: 80,
    accepts: "image",
    name: { en: "Images to PDF", hi: "तस्वीरों से पीडीएफ़" },
    description: {
      en: "JPG, PNG, WEBP, HEIC, TIFF or SVG into one tidy PDF, camera ready.",
      hi: "JPG, PNG, WEBP, HEIC, TIFF या SVG से एक साफ़ PDF।",
    },
    tags: {
      en: ["photo to pdf", "picture", "jpg png"],
      hi: ["तस्वीर", "photo", "jpg"],
    },
  }),
  def({
    id: "create-photo-collage",
    category: "create",
    mode: "D",
    phase: "P3",
    icon: LayoutTemplate,
    popularity: 12,
    accepts: "image",
    enabled: true,
    name: { en: "Create photo collage", hi: "फ़ोटो कोलाज बनाएँ" },
    description: {
      en: "Grid, mosaic and polaroid collages with captions and a page title — export PDF, JPG or PNG.",
      hi: "ग्रिड, मोज़ेक और पोलरॉइड कोलाज, कैप्शन और पेज शीर्षक के साथ — PDF, JPG या PNG एक्सपोर्ट।",
    },
    tags: { en: ["collage", "grid photos"], hi: ["कोलाज", "collage"] },
  }),
  def({
    id: "create-card",
    category: "create",
    mode: "D",
    phase: "P3",
    icon: Gift,
    popularity: 12,
    accepts: "image",
    enabled: true,
    name: { en: "Create card", hi: "कार्ड बनाएँ" },
    description: {
      en: "Greeting and invitation cards with Hindi festival templates, folded print layout and CSV mail merge.",
      hi: "शुभकामना और निमंत्रण कार्ड — हिंदी त्योहार टेम्पलेट, फ़ोल्ड प्रिंट लेआउट और CSV मेल मर्ज के साथ।",
    },
    tags: {
      en: ["greeting", "invitation", "postcard"],
      hi: ["कार्ड", "निमंत्रण", "card"],
    },
  }),
  def({
    id: "create-fillable-pdf-form",
    category: "create",
    mode: "D",
    phase: "P3",
    icon: FormInput,
    popularity: 12,
    accepts: "any",
    enabled: true,
    name: { en: "Create PDF form", hi: "नया फ़ॉर्म बनाएँ" },
    description: {
      en: "Visual form builder with fields, calculations and validation.",
      hi: "फ़ील्ड, गणना और जाँच वाला फ़ॉर्म बिल्डर।",
    },
    tags: { en: ["form builder", "fields"], hi: ["फ़ॉर्म", "form builder"] },
  }),
  def({
    id: "create-resume",
    category: "create",
    mode: "D",
    phase: "P3",
    icon: Contact,
    popularity: 18,
    accepts: "any",
    enabled: true,
    name: { en: "Create resume", hi: "रिज़्यूमे बनाएँ" },
    description: {
      en: "3 ATS templates, live preview, selectable-text PDF, data stays local.",
      hi: "3 ATS टेम्पलेट, लाइव प्रीव्यू, चुनने योग्य टेक्स्ट वाली PDF, डेटा डिवाइस पर।",
    },
    tags: {
      en: ["cv", "job application", "biodata"],
      hi: ["रिज़्यूमे", "biodata", "cv"],
    },
  }),
  def({
    id: "generate-qr-code",
    category: "create",
    mode: "D",
    phase: "P2",
    icon: QrCode,
    popularity: 20,
    accepts: "any",
    enabled: true,
    name: { en: "Generate QR code", hi: "QR कोड बनाएँ" },
    description: {
      en: "URL, UPI payment, WiFi or vCard QRs with colors and a center logo.",
      hi: "URL, UPI, WiFi या vCard QR — रंग और बीच में लोगो।",
    },
    tags: { en: ["qr", "upi qr", "barcode"], hi: ["क्यूआर", "qr", "upi"] },
  }),

  /* ---------------- Invoices (§7.4) ---------------- */
  def({
    id: "create-invoice",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: Receipt,
    popularity: 32,
    accepts: "any",
    enabled: true,
    name: { en: "Create invoice (GST ready)", hi: "GST इनवॉइस बनाएँ" },
    description: {
      en: "39 templates with CGST/SGST/IGST auto-split, amount in words, UPI QR and saved profile.",
      hi: "39 टेम्पलेट — CGST/SGST/IGST अपने आप, शब्दों में रक़म, UPI QR और सेव प्रोफ़ाइल।",
    },
    tags: {
      en: ["gst invoice", "bill", "tax invoice", "invoice maker"],
      hi: ["बिल", "गस्ट", "invoice", "bill banaye"],
    },
  }),
  def({
    id: "create-invoice-visually",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: Palette,
    popularity: 10,
    accepts: "any",
    name: { en: "Create invoice visually", hi: "इनवॉइस डिज़ाइन करें" },
    description: {
      en: "Free-layout designer: drag text, logo and the items table on an A4 canvas — the PDF reproduces your exact layout.",
      hi: "फ़्री-लेआउट डिज़ाइनर: A4 कैनवास पर टेक्स्ट, लोगो और आइटम टेबल खींचकर रखें — PDF आपकी सटीक लयआउट जैसी बनती है।",
    },
    tags: { en: ["invoice design", "canvas", "free layout"], hi: ["इनवॉइस", "design"] },
    enabled: true,
  }),
  def({
    id: "create-electronic-invoice",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: FileCode,
    popularity: 8,
    accepts: "pdf",
    name: { en: "Electronic invoice (Factur-X)", hi: "ई-इनवॉइस (Factur-X)" },
    description: {
      en: "Embed your CII XML into a PDF as the Factur-X attachment with the XMP stamp — entirely on-device. Not a PDF/A-3 conversion.",
      hi: "अपनी CII XML को PDF में Factur-X अटैचमेंट + XMP स्टैम्प के साथ जोड़ें — पूरी तरह डिवाइस पर। यह PDF/A-3 रूपांतरण नहीं है।",
    },
    tags: { en: ["factur-x", "zugferd", "e-invoice"], hi: ["ई-इनवॉइस", "factur"] },
    enabled: true,
  }),
  def({
    id: "pdf-to-e-invoice",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: ArrowRightLeft,
    popularity: 8,
    accepts: "pdf",
    name: { en: "PDF invoice to e-invoice", hi: "पीडीएफ़ से ई-इनवॉइस" },
    description: {
      en: "Pull the embedded Factur-X/ZUGFeRD XML out of an e-invoice PDF, or best-effort read a plain invoice's fields — every hit shows its source snippet.",
      hi: "ई-इनवॉइस PDF से जुड़ी Factur-X/ZUGFeRD XML निकालें, या साधारण इनवॉइस के फ़ील्ड की सर्वश्रेष्ठ कोशिश — हर नतीजे के साथ उसका स्रोत स्निपेट।",
    },
    tags: { en: ["convert invoice", "xml"], hi: ["इनवॉइस", "e-invoice"] },
    enabled: true,
  }),
  def({
    id: "xml-invoice-to-pdf",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: FileText,
    popularity: 8,
    accepts: "text",
    name: { en: "XML e-invoice to PDF", hi: "XML से इनवॉइस पीडीएफ़" },
    description: {
      en: "CII (Factur-X / ZUGFeRD) and UBL 2.1 e-invoice XML → a clean, readable invoice PDF — rendered entirely on your device.",
      hi: "CII (Factur-X / ZUGFeRD) और UBL 2.1 ई-इनवॉइस XML → साफ़, पढ़ने योग्य इनवॉइस PDF — पूरी तरह आपके डिवाइस पर बनती है।",
    },
    tags: { en: ["xml invoice", "cii", "factur-x", "ubl"], hi: ["xml", "इनवॉइस"] },
    enabled: true,
  }),
  def({
    id: "validate-e-invoice",
    category: "invoices",
    mode: "D",
    phase: "P3",
    icon: BadgeCheck,
    popularity: 6,
    accepts: "text",
    name: { en: "Validate e-invoice", hi: "ई-इनवॉइस जाँचें" },
    description: {
      en: "Semantic checks for CII e-invoices — totals reconciliation, required fields, tax categories — from the XML or straight out of the PDF attachment.",
      hi: "CII ई-इनवॉइस की सैमेंटिक जाँच — कुल राशियों का मिलान, ज़रूरी फ़ील्ड, टैक्स श्रेणियाँ — XML से या PDF के अटैचमेंट से सीधे।",
    },
    tags: { en: ["validate", "check invoice"], hi: ["जाँच", "validate"] },
    enabled: true,
  }),

  /* ---------------- Optimize (§7.5) ---------------- */
  def({
    id: "compress-pdf",
    category: "optimize",
    mode: "D",
    phase: "P1",
    icon: Minimize2,
    popularity: 92,
    accepts: "pdf",
    enabled: true,
    name: { en: "Compress PDF", hi: "पीडीएफ़ कंप्रेस करें" },
    description: {
      en: "Quality presets or custom DPI — smaller file, same readable text.",
      hi: "क्वालिटी प्रीसेट या कस्टम DPI — छोटी फ़ाइल, साफ़ टेक्स्ट।",
    },
    tags: {
      en: ["reduce size", "smaller", "shrink"],
      hi: ["छोटा", "कंप्रेस", "compress karein"],
    },
  }),
  def({
    id: "compress-pdf-to-size",
    category: "optimize",
    mode: "D",
    phase: "P2",
    icon: Target,
    popularity: 48,
    accepts: "pdf",
    enabled: true,
    name: { en: "Compress to target size", hi: "लक्ष्य साइज़ में कंप्रेस" },
    description: {
      en: "Under 100 KB / 200 KB / 1 MB for form portals and email limits.",
      hi: "100 KB / 200 KB / 1 MB से कम — फ़ॉर्म और ईमेल के लिए।",
    },
    tags: {
      en: ["100kb", "200kb", "target size"],
      hi: ["100kb", "200kb", "छोटा karein"],
    },
  }),
  def({
    id: "web-optimize-pdf",
    category: "optimize",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Zap,
    popularity: 10,
    accepts: "pdf",
    name: { en: "Web optimize PDF", hi: "वेब के लिए PDF ऑप्टिमाइज़ करें" },
    description: {
      en: "Structural tune-up for online viewing: packed object streams, max-level stream recompression, junk-object removal — on-device.",
      hi: "ऑनलाइन देखने के लिए स्ट्रक्चरल सुधार: पैक किए ऑब्जेक्ट स्ट्रीम, अधिकतम लेवल स्ट्रीम कंप्रेशन, बेकार ऑब्जेक्ट हटाना — डिवाइस पर।",
    },
    tags: {
      en: ["web optimize", "fast web view", "object streams"],
      hi: ["वेब ऑप्टिमाइज़", "fast web view"],
    },
  }),
  def({
    id: "ocr-pdf",
    category: "optimize",
    mode: "D",
    phase: "P2",
    icon: ScanText,
    popularity: 52,
    accepts: "pdf",
    enabled: true,
    name: { en: "PDF OCR", hi: "पीडीएफ़ OCR" },
    description: {
      en: "Make scanned PDFs searchable; English and Hindi models included.",
      hi: "स्कैन PDF खोजने योग्य बनाएँ; हिंदी मॉडल सहित।",
    },
    tags: {
      en: ["searchable", "hindi ocr", "text recognition"],
      hi: ["ओसीआर", "ocr", "हिंदी पहचान"],
    },
  }),
  def({
    id: "repair-pdf",
    category: "optimize",
    mode: "D",
    phase: "P3",
    icon: Wrench,
    popularity: 22,
    accepts: "pdf",
    enabled: true,
    name: { en: "Repair PDF", hi: "पीडीएफ़ ठीक करें" },
    description: {
      en: "Raw-byte salvage for damaged PDFs: rebuilds broken xref tables, fixes headers, stream lengths, duplicates and missing EOF — and reports what truly survived.",
      hi: "ख़राब PDF की रॉ-बाइट मरम्मत: टूटी xref टेबल, हेडर, स्ट्रीम लंबाई, डुप्लिकेट और ग़ायब EOF ठीक होते हैं — साथ में ईमानदार रिपोर्ट कि असल में क्या बचा।",
    },
    tags: {
      en: ["fix pdf", "corrupt", "damaged", "recover"],
      hi: ["मरम्मत", "repair", "theek", "खराब pdf"],
    },
  }),
  def({
    id: "rasterize-pdf",
    category: "optimize",
    mode: "D",
    phase: "P2",
    icon: Image,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Rasterize PDF", hi: "पेज तस्वीर बनाएँ" },
    description: {
      en: "Convert pages to flat images so nothing can be edited or extracted.",
      hi: "पेज तस्वीर बना दें — कुछ बदला न जा सके।",
    },
    tags: { en: ["flatten to image", "non editable"], hi: ["रास्टर", "तस्वीर"] },
  }),
  def({
    id: "flatten-pdf",
    category: "optimize",
    mode: "D",
    phase: "P2",
    icon: SquareStack,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Flatten PDF", hi: "फ़्लैटन पीडीएफ़" },
    description: {
      en: "Merge form fields and annotations into the page content.",
      hi: "फ़ॉर्म फ़ील्ड और टिप्पणियाँ पेज में मिला दें।",
    },
    tags: { en: ["flatten forms", "annotations"], hi: ["फ़्लैटन", "flatten"] },
  }),
  def({
    id: "remove-annotations",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: MessageSquareOff,
    popularity: 26,
    accepts: "pdf",
    enabled: true,
    name: { en: "Remove annotations", hi: "एनोटेशन हटाएँ" },
    description: {
      en: "Strip comments, highlights and drawings — keep links and form fields alive.",
      hi: "टिप्पणियाँ, हाइलाइट और ड्रॉइंग हटाएँ — लिंक और फ़ॉर्म फ़ील्ड ज़िंदा रहें।",
    },
    tags: {
      en: ["remove comments pdf", "delete highlights", "clean markup"],
      hi: ["एनोटेशन हटाएँ", "टिप्पणियाँ हटाएँ", "clean pdf"],
    },
  }),
  def({
    id: "pdf-to-pdfa",
    category: "optimize",
    mode: "D",
    phase: "P3",
    icon: FileCheck,
    popularity: 10,
    accepts: "pdf",
    enabled: true,
    name: { en: "PDF to PDF/A", hi: "PDF/A बनाएँ" },
    description: {
      en: "Convert to archive-grade PDF/A-1b/2b/3b on-device: fonts embedded or substituted, device colors rewritten to DeviceRGB, JavaScript and multimedia stripped, XMP identification + a real sRGB OutputIntent written — with a plain-text change report.",
      hi: "अभिलेख-ग्रेड PDF/A-1b/2b/3b में बदलें, पूरा काम डिवाइस पर: फ़ॉन्ट एम्बेड या विकल्प, डिवाइस रंग DeviceRGB में, JavaScript और मल्टीमीडिया हटाकर, XMP पहचान + असली sRGB OutputIntent के साथ — और साफ़ टेक्स्ट बदलाव रिपोर्ट।",
    },
    tags: { en: ["pdfa", "archive"], hi: ["पीडीएफ़ए", "archive"] },
  }),

  /* ---------------- Security (§7.6) ---------------- */
  def({
    id: "lock-pdf",
    category: "security",
    mode: "D",
    phase: "P1",
    icon: Lock,
    popularity: 78,
    accepts: "pdf",
    enabled: true,
    name: { en: "Protect PDF", hi: "पासवर्ड लगाएँ" },
    description: {
      en: "AES-256 password with print/copy/edit permission switches.",
      hi: "AES-256 पासवर्ड, प्रिंट/कॉपी/एडिट अनुमति के साथ।",
    },
    tags: {
      en: ["password", "encrypt", "secure"],
      hi: ["पासवर्ड", "लॉक", "password lagaye"],
    },
  }),
  def({
    id: "unlock-pdf",
    category: "security",
    mode: "D",
    phase: "P1",
    icon: EyeOff,
    popularity: 75,
    accepts: "pdf",
    enabled: true,
    name: { en: "Unlock PDF", hi: "लॉक हटाएँ" },
    description: {
      en: "Remove a password you know, or owner restrictions — no cracking.",
      hi: "अपना पासवर्ड हटाएँ — तोड़ना नहीं, हटाना।",
    },
    tags: {
      en: ["remove password", "decrypt"],
      hi: ["अनलॉक", "unlock", "hataye"],
    },
  }),
  def({
    id: "change-permissions",
    category: "security",
    mode: "D",
    phase: "P2",
    icon: UserCog,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Change permissions", hi: "अनुमतियाँ बदलें" },
    description: {
      en: "Restrict printing, copying, editing — the file still opens for everyone.",
      hi: "प्रिंट, कॉपी, एडिट पर पाबंदी — फ़ाइल फिर भी सबके लिए खुलती है।",
    },
    tags: {
      en: ["pdf permissions", "restrict printing", "no copy pdf"],
      hi: ["अनुमतियाँ", "permissions", "restriction"],
    },
  }),
  def({
    id: "sign-pdf",
    category: "security",
    mode: "D",
    phase: "P1",
    icon: PenTool,
    popularity: 88,
    accepts: "pdf",
    enabled: true,
    name: { en: "Sign PDF", hi: "हस्ताक्षर करें" },
    description: {
      en: "Draw, type or upload your signature; place it on any page.",
      hi: "हस्ताक्षर बनाएँ या अपलोड करें; किसी भी पेज पर लगाएँ।",
    },
    tags: {
      en: ["signature", "esign", "sign document"],
      hi: ["हस्ताक्षर", "sign", "signature"],
    },
  }),
  def({
    id: "digital-signature",
    category: "security",
    mode: "D",
    phase: "P3",
    icon: ShieldCheck,
    popularity: 12,
    accepts: "pdf",
    enabled: true,
    name: { en: "Digital signature", hi: "डिजिटल हस्ताक्षर" },
    description: {
      en: "Certificate-based PAdES signing with your .pfx/.p12 file.",
      hi: "सर्टिफ़िकेट (.pfx/.p12) से PAdES हस्ताक्षर।",
    },
    tags: {
      en: ["pades", "certificate", "p12"],
      hi: ["डिजिटल", "certificate"],
    },
  }),
  def({
    id: "redact-pdf",
    category: "security",
    mode: "D",
    phase: "P3",
    icon: EyeOff,
    popularity: 28,
    accepts: "pdf",
    enabled: true,
    name: { en: "Redact PDF", hi: "रिडैक्ट करें" },
    description: {
      en: "Permanently hide Aadhaar, PAN, phone or custom text — verified gone.",
      hi: "आधार, पैन, फ़ोन नंबर हमेशा के लिए छिपाएँ।",
    },
    tags: {
      en: ["aadhaar", "pan", "black out", "censor"],
      hi: ["आधार", "छिपाएँ", "aadhaar"],
    },
  }),
  def({
    id: "remove-pdf-metadata",
    category: "security",
    mode: "D",
    phase: "P1",
    icon: FileX,
    popularity: 20,
    accepts: "pdf",
    enabled: true,
    name: { en: "Remove PDF metadata", hi: "मेटाडेटा हटाएँ" },
    description: {
      en: "See every hidden field — author, software, dates — then strip them.",
      hi: "छुपी जानकारी देखें — फिर साफ़ मिटाएँ।",
    },
    tags: {
      en: ["metadata", "privacy clean", "xmp"],
      hi: ["मेटाडेटा", "metadata", "saf"],
    },
  }),
  def({
    id: "sanitize-pdf",
    category: "security",
    mode: "D",
    phase: "P2",
    icon: ShieldCheck,
    popularity: 24,
    accepts: "pdf",
    enabled: true,
    name: { en: "Sanitize PDF", hi: "PDF सैनिटाइज़ करें" },
    description: {
      en: "One tap: comments, links, form fields, hidden data, metadata and scripts — gone.",
      hi: "एक टैप: टिप्पणियाँ, लिंक, फ़ॉर्म फ़ील्ड, छिपा डेटा, मेटाडेटा और स्क्रिप्ट — साफ़।",
    },
    tags: {
      en: ["sanitize", "privacy clean", "strip annotations"],
      hi: ["सैनिटाइज़", "sanitize", "saf"],
    },
  }),
  def({
    id: "bates-numbering",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: Hash,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Bates numbering", hi: "बेट्स नंबरिंग" },
    description: {
      en: "Legal sequential page stamps — DOC-000001, DOC-000002, …",
      hi: "कानूनी क्रमिक पेज स्टैम्प — DOC-000001, DOC-000002, …",
    },
    tags: {
      en: ["bates numbering", "legal stamp", "page stamp"],
      hi: ["बेट्स", "bates", "legal numbering"],
    },
  }),
  def({
    id: "add-stamps",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: BadgeCheck,
    popularity: 17,
    accepts: "pdf",
    enabled: true,
    name: { en: "Add stamp", hi: "स्टैम्प लगाएँ" },
    description: {
      en: "APPROVED, DRAFT, CONFIDENTIAL — rubber stamps in any corner.",
      hi: "APPROVED, DRAFT, CONFIDENTIAL — किसी भी कोने में रबर स्टैम्प।",
    },
    tags: {
      en: ["stamp pdf", "approved stamp", "draft stamp"],
      hi: ["स्टैम्प", "stamp", "mohar"],
    },
  }),
  def({
    id: "background-color",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: Palette,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Background color", hi: "बैकग्राउंड रंग" },
    description: {
      en: "Fill pages with ivory, yellow or any hex — behind the text.",
      hi: "पेजों को आइवरी, पीला या कोई भी हेक्स भरें — टेक्स्ट के पीछे।",
    },
    tags: {
      en: ["page background", "background color", "color pages"],
      hi: ["बैकग्राउंड", "रंग भरें", "page color"],
    },
  }),
  def({
    id: "remove-blank-pages",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: FileMinus,
    popularity: 20,
    accepts: "pdf",
    enabled: true,
    name: { en: "Remove blank pages", hi: "ख़ाली पेज हटाएँ" },
    description: {
      en: "Finds pages with no marks — text, drawing or image — and drops them.",
      hi: "बिना निशान वाले पेज — न टेक्स्ट, न रेखा, न तस्वीर — हटा देता है।",
    },
    tags: {
      en: ["remove blank pages", "delete empty pages", "blank page remover"],
      hi: ["ख़ाली पेज हटाएँ", "blank pages", "khaali page"],
    },
  }),
  def({
    id: "alternate-merge",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: ArrowRightLeft,
    popularity: 15,
    accepts: "pdf",
    enabled: true,
    name: { en: "Alternate merge", hi: "एक-एक कर मर्ज करें" },
    description: {
      en: "Weave two PDFs page by page — front scan + back scan, done.",
      hi: "दो PDF पेज-दर-पेज बुनें — आगे का स्कैन + पीछे का स्कैन, बस।",
    },
    tags: {
      en: ["alternate merge", "interleave pdf", "odd even merge"],
      hi: ["एक-एक मर्ज", "interleave", "alternate merge"],
    },
  }),
  def({
    id: "add-page-labels",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: ListOrdered,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Add page labels", hi: "पेज लेबल जोड़ें" },
    description: {
      en: "Logical numbering viewers show — i, ii, iii or 1, 2, 3.",
      hi: "व्यूअर में दिखने वाला लॉजिकल नंबरिंग — i, ii, iii या 1, 2, 3।",
    },
    tags: {
      en: ["page labels", "logical numbering", "roman numerals pdf"],
      hi: ["पेज लेबल", "page labels", "roman numbering"],
    },
  }),
  def({
    id: "rotate-custom",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: DraftingCompass,
    popularity: 13,
    accepts: "pdf",
    enabled: true,
    name: { en: "Rotate by custom angle", hi: "कस्टम कोण से घुमाएँ" },
    description: {
      en: "Any fraction of a degree — straighten tilted scans or turn pages to any angle.",
      hi: "डिग्री का कोई भी हिस्सा — तिरछे स्कैन सीधे करें या किसी भी कोण पर घुमाएँ।",
    },
    tags: {
      en: ["rotate pdf custom angle", "straighten pdf", "tilted scan fix"],
      hi: ["कोण से घुमाएँ", "custom rotate", "tilt fix"],
    },
  }),
  def({
    id: "pdfs-to-zip",
    category: "organize",
    mode: "D",
    phase: "P2",
    icon: FileArchive,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "PDFs to ZIP", hi: "PDF से ZIP" },
    description: {
      en: "Bundle 2–20 PDFs into one archive — a single download, exact bytes.",
      hi: "2–20 PDF को एक आर्काइव में — एक ही डाउनलोड, बाइट-दर-बाइट वैसी।",
    },
    tags: {
      en: ["pdf to zip", "bundle pdfs", "zip pdf files"],
      hi: ["PDF ज़िप", "zip pdf", "bundle"],
    },
  }),
  def({
    id: "invert-pdf-colors",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: Contrast,
    popularity: 15,
    accepts: "pdf",
    enabled: true,
    name: { en: "Invert colors", hi: "रंग उलटें" },
    description: {
      en: "Flip every color — the photographic negative of your pages.",
      hi: "हर रंग पलटें — पेजों की फ़ोटोग्राफ़िक निगेटिव कॉपी।",
    },
    tags: {
      en: ["invert pdf colors", "negative pdf", "dark mode pdf"],
      hi: ["रंग उलटें", "invert colors", "negative pdf"],
    },
  }),
  def({
    id: "pdf-to-greyscale",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: Blend,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Convert to greyscale", hi: "ग्रेस्केल बनाएँ" },
    description: {
      en: "Eye-weighted greyscale pages — printer-friendly, ink-saving.",
      hi: "आँख के हिसाब से ग्रे पेज — प्रिंटर-फ़्रेंडली, स्याही बचाने वाले।",
    },
    tags: {
      en: ["pdf to greyscale", "grayscale pdf", "black and white pdf"],
      hi: ["ग्रेस्केल", "greyscale pdf", "काला सफ़ेद pdf"],
    },
  }),
  def({
    id: "scanner-effect",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: ScanLine,
    popularity: 13,
    accepts: "pdf",
    enabled: true,
    name: { en: "Scanner effect", hi: "स्कैनर इफ़ेक्ट" },
    description: {
      en: "Make crisp digital pages look like flatbed-scanned copies.",
      hi: "साफ़ डिजिटल पेजों को फ़्लैटबेड-स्कैन कॉपी जैसा बनाएँ।",
    },
    tags: {
      en: ["make pdf look scanned", "scanner effect", "fake scan pdf"],
      hi: ["स्कैनर इफ़ेक्ट", "scanned pdf look", "scan jaisa pdf"],
    },
  }),
  def({
    id: "posterize-pdf",
    category: "edit",
    mode: "D",
    phase: "P2",
    icon: LayoutGrid,
    popularity: 12,
    accepts: "pdf",
    enabled: true,
    name: { en: "Posterize colors", hi: "पोस्टराइज़ करें" },
    description: {
      en: "Snap colors to a few flat levels — the bold poster look.",
      hi: "रंगों को कुछ फ़्लैट लेवल पर बैठाएँ — बोल्ड पोस्टर लुक।",
    },
    tags: {
      en: ["posterize pdf", "reduce colors pdf", "flat colors pdf"],
      hi: ["पोस्टराइज़", "posterize", "flat colors pdf"],
    },
  }),
  def({
    id: "generate-password",
    category: "security",
    mode: "D",
    phase: "P1",
    icon: KeyRound,
    popularity: 26,
    accepts: "any",
    enabled: true,
    name: { en: "Generate password", hi: "पासवर्ड बनाएँ" },
    description: {
      en: "Strong random or pronounceable passwords — nothing stored.",
      hi: "मज़बूत पासवर्ड — कुछ भी सेव नहीं होता।",
    },
    tags: {
      en: ["random password", "passphrase"],
      hi: ["पासवर्ड", "password banaye"],
    },
  }),
  def({
    id: "request-signature",
    category: "security",
    mode: "D",
    phase: "P3",
    icon: Send,
    popularity: 8,
    accepts: "pdf",
    enabled: true,
    name: { en: "Request signature", hi: "हस्ताक्षर मँगाएँ" },
    description: {
      en: "Prepare a signing pack: numbered sign-here fields, request note and mail draft — on-device.",
      hi: "साइनिंग पैक बनाएँ: नंबर वाले हस्ताक्षर फ़ील्ड, अनुरोध पत्र और मेल ड्राफ़्ट — ऑन-डिवाइस।",
    },
    tags: {
      en: ["prepare for signature", "sign request", "signature fields"],
      hi: ["हस्ताक्षर मँगाएँ", "साइनिंग पैक"],
    },
  }),

  /* ---------------- View (§7.7) ---------------- */
  def({
    id: "view-pdf",
    category: "view",
    mode: "D",
    phase: "P1",
    icon: Eye,
    popularity: 60,
    accepts: "pdf",
    enabled: true,
    name: { en: "View PDF", hi: "पीडीएफ़ देखें" },
    description: {
      en: "Fast viewer: thumbnails, search, outline, dark reading mode.",
      hi: "तेज़ व्यूअर: थंबनेल, खोज, आउटलाइन, डार्क मोड।",
    },
    tags: { en: ["reader", "open pdf", "viewer"], hi: ["देखें", "reader", "viewer"] },
  }),
  def({
    id: "chat-with-pdf",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: Search,
    popularity: 70,
    accepts: "pdf",
    enabled: true,
    name: { en: "Ask PDF (smart search)", hi: "पीडीएफ़ से पूछें (स्मार्ट खोज)" },
    description: {
      en: "BM25 smart search inside your PDF — ranked passages, page numbers, highlighted terms. 100% on-device.",
      hi: "अपनी PDF के अंदर BM25 स्मार्ट खोज — रैंक किए हिस्से, पेज नंबर, उजले शब्द। 100% डिवाइस पर।",
    },
    tags: {
      en: ["ask pdf", "smart search", "find in pdf"],
      hi: ["पूछें", "खोज", "search"],
    },
  }),
  def({
    id: "summarize-pdf",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: AlignLeft,
    popularity: 74,
    accepts: "pdf",
    enabled: true,
    name: { en: "Summarize PDF", hi: "PDF सारांश" },
    description: {
      en: "One-tap TL;DR with key points and page citations — TextRank on-device, English or Hindi, free.",
      hi: "एक टैप में TL;DR — मुख्य बातें और पेज संदर्भ — TextRank डिवाइस पर, अंग्रेज़ी या हिन्दी, मुफ़्त।",
    },
    tags: {
      en: ["summary", "tldr", "key points"],
      hi: ["सारांश", "summary", "मुख्य बातें"],
    },
  }),
  def({
    id: "compare-pdf",
    category: "view",
    mode: "D",
    phase: "P3",
    icon: GitCompare,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "Compare PDFs", hi: "पीडीएफ़ तुलना करें" },
    description: {
      en: "Side-by-side sync scroll, overlay diff and a text change list.",
      hi: "साथ-साथ स्क्रॉल, ओवरले डिफ़, बदलावों की सूची।",
    },
    tags: { en: ["diff", "side by side"], hi: ["तुलना", "compare", "diff"] },
  }),
  def({
    id: "search-pdf",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: FileSearch,
    popularity: 18,
    accepts: "pdf",
    enabled: true,
    name: { en: "Search in PDFs", hi: "पीडीएफ़ में खोजें" },
    description: {
      en: "Query or regex across many PDFs; jump to each match's page.",
      hi: "कई PDF में खोजें; हर मैच के पेज पर जाएँ।",
    },
    tags: { en: ["find text", "regex search"], hi: ["खोजें", "search", "khojein"] },
  }),
  def({
    id: "view-metadata",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: Info,
    popularity: 15,
    accepts: "pdf",
    enabled: true,
    name: { en: "View PDF metadata", hi: "PDF मेटाडेटा देखें" },
    description: {
      en: "Everything a PDF says about itself — info fields, page sizes, XMP — as a report.",
      hi: "PDF की अपनी सारी बातें — इन्फ़ो फ़ील्ड, पेज साइज़, XMP — एक रिपोर्ट में।",
    },
    tags: {
      en: ["pdf metadata viewer", "document info", "pdf inspector"],
      hi: ["मेटाडेटा देखें", "metadata", "inspector"],
    },
  }),
  def({
    id: "page-dimensions",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: Ruler,
    popularity: 14,
    accepts: "pdf",
    enabled: true,
    name: { en: "Page dimensions", hi: "पेज साइज़ पहचानें" },
    description: {
      en: "What paper is this PDF? Sizes in mm/inch/pt, orientation, mixed-page detection.",
      hi: "यह PDF किस पेपर की है? साइज़ mm/इंच/पॉइंट में, दिशा, मिक्स-पेज पहचान।",
    },
    tags: {
      en: ["pdf page size", "check paper size", "a4 or letter"],
      hi: ["पेज साइज़", "page size", "a4 letter"],
    },
  }),
  def({
    id: "validate-pdfa",
    category: "view",
    mode: "D",
    phase: "P3",
    icon: BadgeCheck,
    popularity: 6,
    accepts: "pdf",
    enabled: true,
    name: { en: "Check PDF/A & PDF/UA", hi: "PDF/A जाँचें" },
    description: {
      en: "On-device PDF/A conformance check (1b/2b/3b or auto-detected from XMP): pass/fail/warning cards with page references, unembedded fonts, forbidden content and a report — plus three advisory PDF/UA hints, not full PDF/UA validation.",
      hi: "PDF/A अनुरूपता जाँच, पूरी डिवाइस पर (1b/2b/3b या XMP से ऑटो): पास/फ़ेल/चेतावनी कार्ड पेज संदर्भों, ग़ैर-एम्बेडेड फ़ॉन्ट और निषिद्ध सामग्री के साथ — रिपोर्ट भी; तीन सलाहकारी PDF/UA संकेत, पूरी PDF/UA जाँच नहीं।",
    },
    tags: { en: ["validate pdfa", "accessibility check"], hi: ["जाँच", "pdfa"] },
  }),
  def({
    id: "verify-pdf-signatures",
    category: "view",
    mode: "D",
    phase: "P3",
    icon: Award,
    popularity: 8,
    accepts: "pdf",
    enabled: true,
    name: { en: "Verify PDF signatures", hi: "हस्ताक्षर जाँचें" },
    description: {
      en: "Signer, time, certificate status and tamper detection.",
      hi: "हस्ताक्षरकर्ता, समय, सर्टिफ़िकेट और छेड़छाड़ जाँच।",
    },
    tags: {
      en: ["check signature", "tamper"],
      hi: ["हस्ताक्षर जाँच", "verify"],
    },
  }),
  def({
    id: "set-pdf-viewer-preferences",
    category: "view",
    mode: "D",
    phase: "P2",
    icon: Settings2,
    popularity: 6,
    accepts: "pdf",
    enabled: true,
    name: { en: "Set viewer preferences", hi: "व्यूअर सेटिंग बदलें" },
    description: {
      en: "Choose how the file opens: layout, zoom, window title.",
      hi: "फ़ाइल कैसे खुले: लेआउट, ज़ूम, टाइटल।",
    },
    tags: { en: ["open settings", "initial view"], hi: ["व्यूअर", "settings"] },
  }),

  /* ---------------- Convert to PDF (§7.8) ---------------- */
  def({
    id: "word-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: FileText,
    popularity: 85,
    accepts: "word",
    name: { en: "Word to PDF", hi: "वर्ड से पीडीएफ़" },
    description: {
      en: "DOC/DOCX to clean PDF; deleted from the server right after.",
      hi: "DOC/DOCX से साफ़ PDF; काम के बाद तुरंत डिलीट।",
    },
    tags: {
      en: ["docx", "doc", "word document"],
      hi: ["वर्ड", "docx", "word"],
    },
  }),
  def({
    id: "powerpoint-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Presentation,
    popularity: 30,
    accepts: "office",
    name: { en: "PowerPoint to PDF", hi: "पावरपॉइंट से पीडीएफ़" },
    description: {
      en: "Turn .pptx decks into vector PDFs on-device — one page per slide, optional speaker-notes pages.",
      hi: ".pptx डेक को वेक्टर PDF में बदलें, पूरी तरह डिवाइस पर — हर स्लाइड एक पेज, स्पीकर-नोट्स पेज वैकल्पिक।",
    },
    tags: { en: ["pptx", "slides"], hi: ["पावरपॉइंट", "pptx"] },
  }),
  def({
    id: "excel-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: FileSpreadsheet,
    popularity: 28,
    accepts: "office",
    name: { en: "Excel to PDF", hi: "एक्सेल से पीडीएफ़" },
    description: {
      en: "XLS/XLSX sheets fitted to page width, selected sheets or all.",
      hi: "XLS/XLSX शीट पेज-चौड़ाई में, सब या चुनी शीट।",
    },
    tags: { en: ["xlsx", "spreadsheet"], hi: ["एक्सेल", "xlsx"] },
  }),
  def({
    id: "publisher-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Newspaper,
    popularity: 6,
    accepts: "office",
    name: { en: "Publisher to PDF", hi: "पब्लिशर से पीडीएफ़" },
    description: {
      en: "Text stories salvaged from .pub files into clean PDFs, right in your browser. Layout, images and shapes are not carried over — .pub is undocumented, so this is an honest text rescue.",
      hi: ".pub फ़ाइलों की स्टोरी टेक्स्ट साफ़ PDF में — आपके ब्राउज़र में ही। लेआउट, तस्वीरें और आकृतियाँ नहीं आतीं — .pub अप्रलेखित है, इसलिए यह ईमानदार टेक्स्ट बचाव है।",
    },
    tags: { en: ["pub", "publisher"], hi: ["पब्लिशर", "pub"] },
  }),
  def({
    id: "odt-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Files,
    popularity: 8,
    accepts: "office",
    name: { en: "OpenDocument to PDF", hi: "ओपनडॉक्यूमेंट से पीडीएफ़" },
    description: {
      en: "ODT text and ODS sheets into tidy PDFs, parsed right in your browser. .odp/.odg not supported.",
      hi: "ODT टेक्स्ट और ODS शीट साफ़ PDF में — आपके ब्राउज़र में ही। .odp/.odg समर्थित नहीं।",
    },
    tags: { en: ["odt", "ods", "opendocument"], hi: ["ओपनडॉक्यूमेंट", "odt"] },
  }),
  def({
    id: "rtf-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: FileType,
    popularity: 6,
    accepts: "office",
    name: { en: "RTF to PDF", hi: "RTF से पीडीएफ़" },
    description: {
      en: "RTF documents into tidy PDFs — control words parsed right in your browser.",
      hi: "RTF दस्तावेज़ साफ़ PDF में — कंट्रोल-वर्ड आपके ब्राउज़र में ही पढ़े जाते हैं।",
    },
    tags: { en: ["rtf", "rich text"], hi: ["आरटीएफ़", "rtf"] },
  }),
  def({
    id: "epub-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: BookOpen,
    popularity: 10,
    accepts: "text",
    name: { en: "EPUB to PDF", hi: "EPUB से पीडीएफ़" },
    description: {
      en: "EPUB ebooks reflowed onto printable PDF pages — chapters, cover and contents page, all converted in your browser.",
      hi: "EPUB ईबुक प्रिंट-योग्य PDF पेजों पर — अध्याय, कवर और विषय-सूची, सब आपके ब्राउज़र में।",
    },
    tags: { en: ["ebook", "epub"], hi: ["ईबुक", "epub"] },
  }),
  def({
    id: "txt-to-pdf",
    category: "convert-to",
    mode: "D",
    phase: "P2",
    icon: AlignLeft,
    popularity: 18,
    accepts: "text",
    enabled: true,
    name: { en: "Text to PDF", hi: "टेक्स्ट से पीडीएफ़" },
    description: {
      en: "Plain text files into PDF with font and margin control.",
      hi: "टेक्स्ट फ़ाइल से PDF — फ़ॉन्ट और मार्जिन चुनें।",
    },
    tags: { en: ["txt", "plain text"], hi: ["टेक्स्ट", "txt"] },
  }),
  def({
    id: "markdown-to-pdf",
    category: "convert-to",
    mode: "D",
    phase: "P2",
    icon: Hash,
    popularity: 14,
    accepts: "text",
    enabled: true,
    name: { en: "Markdown to PDF", hi: "मार्कडाउन से पीडीएफ़" },
    description: {
      en: "READMEs and notes rendered with headings, lists and code blocks.",
      hi: "हेडिंग, लिस्ट और कोड के साथ सजा PDF।",
    },
    tags: { en: ["md", "readme"], hi: ["मार्कडाउन", "markdown"] },
  }),
  def({
    id: "html-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Code,
    popularity: 12,
    accepts: "text",
    name: { en: "HTML to PDF", hi: "HTML से पीडीएफ़" },
    description: {
      en: "HTML files to PDF on-device — headings, lists, tables, code blocks and links as selectable vector text.",
      hi: "HTML फ़ाइलें PDF में, पूरी तरह डिवाइस पर — हेडिंग, सूचियाँ, टेबल, कोड-ब्लॉक और लिंक चुनने योग्य वेक्टर टेक्स्ट में।",
    },
    tags: { en: ["web page", "html file"], hi: ["एचटीएमएल", "html"] },
  }),
  def({
    id: "jpg-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: FileImage,
    popularity: 72,
    accepts: "image",
    name: { en: "JPG to PDF", hi: "JPG से पीडीएफ़" },
    description: {
      en: "Photos to PDF with page size, margins and orientation options.",
      hi: "फ़ोटो से PDF — साइज़, मार्जिन, दिशा चुनें।",
    },
    tags: {
      en: ["jpeg", "photo pdf", "jpg file"],
      hi: ["जेपीजी", "photo se pdf", "jpg"],
    },
  }),
  def({
    id: "png-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: FileImage,
    popularity: 56,
    accepts: "image",
    name: { en: "PNG to PDF", hi: "PNG से पीडीएफ़" },
    description: {
      en: "Keep transparency or white background — your choice.",
      hi: "पारदर्शिता या सफ़ेद पृष्ठभूमि — आप चुनें।",
    },
    tags: { en: ["png image", "screenshot"], hi: ["पीएनजी", "png"] },
  }),
  def({
    id: "webp-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: FileImage,
    popularity: 22,
    accepts: "image",
    name: { en: "WEBP to PDF", hi: "WEBP से पीडीएफ़" },
    description: {
      en: "Modern web images converted on your device.",
      hi: "नई वेब तस्वीरें, डिवाइस पर ही बदलें।",
    },
    tags: { en: ["webp image"], hi: ["वेबपी", "webp"] },
  }),
  def({
    id: "heic-to-pdf",
    category: "convert-to",
    mode: "D",
    enabled: true,
    phase: "P2",
    icon: FileImage,
    popularity: 26,
    accepts: "image",
    name: { en: "HEIC to PDF", hi: "HEIC से पीडीएफ़" },
    description: {
      en: "iPhone photos decoded in the browser and placed into PDFs.",
      hi: "iPhone फ़ोटो ब्राउज़र में खुलें, PDF बनें।",
    },
    tags: {
      en: ["iphone photo", "heic decoder"],
      hi: ["आईफ़ोन फ़ोटो", "heic"],
    },
  }),
  def({
    id: "svg-to-pdf",
    category: "convert-to",
    mode: "D",
    phase: "P2",
    icon: Shapes,
    popularity: 12,
    accepts: "image",
    enabled: true,
    name: { en: "SVG to PDF", hi: "SVG से पीडीएफ़" },
    description: {
      en: "Vector graphics rendered at any scale into PDF pages.",
      hi: "वेक्टर ग्राफ़िक्स, किसी भी स्केल पर PDF में।",
    },
    tags: { en: ["vector", "svg file"], hi: ["एसवीजी", "svg"] },
  }),
  def({
    id: "tiff-to-pdf",
    category: "convert-to",
    mode: "D",
    phase: "P2",
    icon: FileImage,
    popularity: 10,
    accepts: "image",
    enabled: true,
    name: { en: "TIFF to PDF", hi: "TIFF से पीडीएफ़" },
    description: {
      en: "Multi-page TIFF scans into one PDF, in order.",
      hi: "मल्टी-पेज TIFF स्कैन एक PDF में, क्रम से।",
    },
    tags: { en: ["tif", "fax scan"], hi: ["टिफ़", "tiff"] },
  }),
  def({
    id: "convert-to-pdf",
    category: "convert-to",
    mode: "D",
    phase: "P1",
    icon: FileInput,
    popularity: 58,
    accepts: "any",
    enabled: true,
    name: { en: "Universal converter", hi: "सब कुछ पीडीएफ़ में" },
    description: {
      en: "Drop any file — we detect the type and route you to the right tool.",
      hi: "कोई भी फ़ाइल डालें — टाइप पहचान कर सही टूल मिलेगा।",
    },
    tags: {
      en: ["any file", "auto detect", "convert"],
      hi: ["कोई भी", "sab kuch", "converter"],
    },
  }),

  /* ---------------- Convert from PDF (§7.9) ---------------- */
  def({
    id: "pdf-to-word",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: FileText,
    popularity: 83,
    accepts: "pdf",
    name: { en: "PDF to Word", hi: "पीडीएफ़ से वर्ड" },
    description: {
      en: "Editable DOCX with honest quality notes and a first-page preview.",
      hi: "एडिट करने योग्य DOCX — ईमानदार क्वालिटी नोट के साथ।",
    },
    tags: {
      en: ["docx", "editable word"],
      hi: ["वर्ड", "docx", "word file"],
    },
  }),
  def({
    id: "pdf-to-powerpoint",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Presentation,
    popularity: 22,
    accepts: "pdf",
    name: { en: "PDF to PowerPoint", hi: "पीडीएफ़ से पावरपॉइंट" },
    description: {
      en: "Pages become editable PPTX slides (or pixel-exact image slides) — on-device, हिंदी without font files.",
      hi: "हर पेज एडिटेबल PPTX स्लाइड बनता है (या पिक्सेल-परफ़ेक्ट इमेज स्लाइड) — डिवाइस पर ही, हिंदी बिना फ़ॉन्ट फ़ाइल।",
    },
    tags: { en: ["pptx", "slides"], hi: ["पावरपॉइंट", "pptx"] },
  }),
  def({
    id: "pdf-to-excel",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: FileSpreadsheet,
    popularity: 24,
    accepts: "pdf",
    name: { en: "PDF to Excel", hi: "पीडीएफ़ से एक्सेल" },
    description: {
      en: "Detected tables become clean sheets with tidy numbers.",
      hi: "पहचानी टेबल साफ़ शीट बनें, नंबर ठीक।",
    },
    tags: { en: ["xlsx", "tables to sheet"], hi: ["एक्सेल", "xlsx", "table"] },
  }),
  def({
    id: "pdf-to-jpg",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 84,
    accepts: "pdf",
    name: { en: "PDF to JPG", hi: "पीडीएफ़ से JPG" },
    description: {
      en: "Every page a JPG at your DPI, single file or ZIP.",
      hi: "हर पेज एक JPG — DPI चुनें, एक फ़ाइल या ZIP।",
    },
    tags: {
      en: ["jpg images", "pages to images"],
      hi: ["जेपीजी", "jpg", "tasveer"],
    },
  }),
  def({
    id: "pdf-to-png",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 70,
    accepts: "pdf",
    name: { en: "PDF to PNG", hi: "पीडीएफ़ से PNG" },
    description: {
      en: "Lossless pages, optional transparent background.",
      hi: "बिना नुक़सान पेज, चाहें तो पारदर्शी पृष्ठभूमि।",
    },
    tags: { en: ["png images", "transparent"], hi: ["पीएनजी", "png"] },
  }),
  def({
    id: "pdf-to-webp",
    category: "convert-from",
    mode: "D",
    phase: "P2",
    icon: Image,
    popularity: 16,
    accepts: "pdf",
    enabled: true,
    name: { en: "PDF to WEBP", hi: "पीडीएफ़ से WEBP" },
    description: {
      en: "Modern web images — 25-35% smaller than JPG, optional transparency.",
      hi: "नई वेब तस्वीरें — JPG से 25-35% छोटी, पारदर्शिता भी।",
    },
    tags: { en: ["webp images"], hi: ["वेबपी", "webp"] },
  }),
  def({
    id: "pdf-to-tiff",
    category: "convert-from",
    mode: "D",
    phase: "P2",
    icon: Image,
    popularity: 8,
    accepts: "pdf",
    enabled: true,
    name: { en: "PDF to TIFF", hi: "पीडीएफ़ से TIFF" },
    description: {
      en: "Archive/fax-grade TIFF — lossless LZW, one multi-page file, DPI stamped in.",
      hi: "अभिलेख/फ़ैक्स दर्जे का TIFF — लॉसलेस LZW, एक मल्टी-पेज फ़ाइल, DPI दर्ज।",
    },
    tags: { en: ["tiff images", "fax"], hi: ["टिफ़", "tiff"] },
  }),
  def({
    id: "pdf-to-svg",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Shapes,
    popularity: 10,
    accepts: "pdf",
    name: { en: "PDF to SVG", hi: "पीडीएफ़ से SVG" },
    description: {
      en: "Vector SVG pages — selectable text, real shapes, on-device.",
      hi: "वेक्टर SVG पेज — चुनने योग्य टेक्स्ट, असली आकृतियाँ, डिवाइस पर।",
    },
    tags: { en: ["vector", "svg file"], hi: ["एसवीजी", "svg"] },
  }),
  def({
    id: "pdf-to-txt",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: AlignLeft,
    popularity: 65,
    accepts: "pdf",
    name: { en: "PDF to Text", hi: "पीडीएफ़ से टेक्स्ट" },
    description: {
      en: "Extract all text instantly; OCR fallback for scans.",
      hi: "सारा टेक्स्ट तुरंत निकालें; स्कैन के लिए OCR।",
    },
    tags: {
      en: ["extract text", "plain text", "copy all"],
      hi: ["टेक्स्ट", "text", "nikalein"],
    },
  }),
  def({
    id: "prepare-pdf-for-ai",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P2",
    icon: BrainCircuit,
    popularity: 68,
    accepts: "pdf",
    name: { en: "Prepare PDF for AI", hi: "PDF को AI के लिए तैयार करें" },
    description: {
      en: "Export your PDF as ready-to-ingest JSON chunks with page map — built for RAG pipelines. 100% on-device.",
      hi: "अपनी PDF को रेडी-टू-इंजेस्ट JSON चंक्स में निर्यात करें, पेज मैप के साथ — RAG पाइपलाइन के लिए। 100% डिवाइस पर।",
    },
    tags: {
      en: ["rag", "llamaindex", "langchain", "json", "chunks"],
      hi: ["आरएजी", "json", "ai", "chunks"],
    },
  }),
  def({
    id: "translate-pdf",
    category: "convert-from",
    mode: "D",
    enabled: false,
    phase: "P3",
    icon: Languages,
    popularity: 72,
    accepts: "pdf",
    aiDependent: true,
    name: { en: "Translate PDF", hi: "PDF अनुवाद" },
    description: {
      en: "Whole-document translation into 13 languages — Hindi, Chinese, Japanese, Korean, Arabic with real fonts — free.",
      hi: "पूरे दस्तावेज़ का अनुवाद 13 भाषाओं में — हिन्दी, चीनी, जापानी, कोरियाई, अरबी असली फ़ॉन्ट के साथ — मुफ़्त।",
    },
    tags: {
      en: ["translate", "hindi", "chinese", "japanese", "korean", "arabic", "language"],
      hi: ["अनुवाद", "translate", "चीनी", "अरबी", "भाषा"],
    },
  }),
  def({
    id: "pdf-to-html",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Code,
    popularity: 10,
    accepts: "pdf",
    name: { en: "PDF to HTML", hi: "पीडीएफ़ से HTML" },
    description: {
      en: "One self-contained .html — reflowed readable or page-faithful, 100% on-device.",
      hi: "एक आत्मनिर्भर .html — साफ़ पढ़ने योग्य या पेज-जैसा, पूरी तरह डिवाइस पर।",
    },
    tags: {
      en: ["html file", "web page", "convert to html"],
      hi: ["एचटीएमएल", "html", "वेबपेज"],
    },
  }),
  def({
    id: "pdf-to-markdown",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Braces,
    popularity: 10,
    accepts: "pdf",
    name: { en: "PDF to Markdown", hi: "पीडीएफ़ से मार्कडाउन" },
    description: {
      en: "Clean UTF-8 .md — headings by size rank, bold/italic, lists, quotes and links; tables stay in PDF to Excel. 100% on-device.",
      hi: "साफ़ UTF-8 .md — फ़ॉन्ट-दरजे से हेडिंग, बोल्ड/इटैलिक, सूचियाँ, कोट और लिंक; टेबल PDF to Excel के लिए। पूरी तरह डिवाइस पर।",
    },
    tags: {
      en: ["md", "markdown notes", "convert to markdown"],
      hi: ["मार्कडाउन", "markdown", "एमडी"],
    },
  }),
  def({
    id: "pdf-to-odt",
    category: "convert-from",
    mode: "D",
    enabled: true,
    phase: "P3",
    icon: Files,
    popularity: 8,
    accepts: "pdf",
    name: { en: "PDF to ODT", hi: "पीडीएफ़ से ODT" },
    description: {
      en: "OpenDocument text — editable in LibreOffice, Word and Google Docs.",
      hi: "OpenDocument टेक्स्ट — LibreOffice, Word और Google Docs में एडिट करने योग्य।",
    },
    tags: {
      en: ["odt", "opendocument", "libreoffice"],
      hi: ["ओडीटी", "opendocument"],
    },
  }),
  def({
    id: "convert-from-pdf",
    category: "convert-from",
    mode: "D",
    phase: "P1",
    icon: FileOutput,
    popularity: 44,
    accepts: "pdf",
    enabled: true,
    name: { en: "Universal converter", hi: "पीडीएफ़ को बदलें" },
    description: {
      en: "Drop a PDF, pick a target format, we route to the right tool.",
      hi: "PDF डालें, फ़ॉर्मैट चुनें — सही टूल खुलेगा।",
    },
    tags: {
      en: ["any format", "convert pdf"],
      hi: ["बदलें", "convert", "badlein"],
    },
  }),

  /* ---------------- Image tools (§7.10) ---------------- */
  def({
    id: "heic-to-jpg",
    category: "images",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 36,
    accepts: "image",
    name: { en: "HEIC to JPG", hi: "HEIC से JPG" },
    description: {
      en: "iPhone photos to universally readable JPG, in your browser.",
      hi: "iPhone फ़ोटो हर जगह चलने वाली JPG में।",
    },
    tags: {
      en: ["iphone", "heic convert"],
      hi: ["आईफ़ोन", "heic", "iphone photo"],
    },
  }),
  def({
    id: "heic-to-png",
    category: "images",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 20,
    accepts: "image",
    name: { en: "HEIC to PNG", hi: "HEIC से PNG" },
    description: {
      en: "Lossless PNG from HEIC without losing quality.",
      hi: "HEIC से बिना नुक़सान PNG।",
    },
    tags: { en: ["iphone png", "heic"], hi: ["आईफ़ोन", "heic png"] },
  }),
  def({
    id: "webp-to-jpg",
    category: "images",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 24,
    accepts: "image",
    name: { en: "WEBP to JPG", hi: "WEBP से JPG" },
    description: {
      en: "Older apps need JPG? Convert instantly, on device.",
      hi: "पुराने ऐप JPG माँगते हैं? तुरंत बदलें।",
    },
    tags: { en: ["webp jpg"], hi: ["वेबपी", "webp jpg"] },
  }),
  def({
    id: "webp-to-png",
    category: "images",
    mode: "D",
    enabled: true,
    phase: "P1",
    icon: Image,
    popularity: 14,
    accepts: "image",
    name: { en: "WEBP to PNG", hi: "WEBP से PNG" },
    description: {
      en: "Lossless PNG from WEBP images.",
      hi: "WEBP से बिना नुक़सान PNG।",
    },
    tags: { en: ["webp png"], hi: ["वेबपी", "webp png"] },
  }),
  def({
    id: "resize-image-kb",
    category: "images",
    mode: "D",
    phase: "P2",
    icon: Scaling,
    popularity: 46,
    accepts: "image",
    enabled: true,
    name: { en: "Resize image to KB", hi: "फ़ोटो साइज़ KB में" },
    description: {
      en: "Photo + signature under 100/200 KB for exam and government forms.",
      hi: "फ़ोटो और साइन 100/200 KB से कम — फ़ॉर्म के लिए।",
    },
    tags: {
      en: ["photo 100kb", "signature resize", "form photo"],
      hi: ["फ़ोटो 100kb", "साइन", "photo kb"],
    },
  }),
  def({
    id: "passport-photo",
    category: "images",
    mode: "D",
    phase: "P3",
    icon: Contact,
    popularity: 20,
    accepts: "image",
    enabled: true,
    name: { en: "Passport photo maker", hi: "पासपोर्ट फ़ोटो बनाएँ" },
    description: {
      en: "India photo sizes, white background and print-ready sheets.",
      hi: "भारतीय साइज़, सफ़ेद पृष्ठभूमि, प्रिंट-रेडी शीट।",
    },
    tags: {
      en: ["passport size", "photo sheet"],
      hi: ["पासपोर्ट", "photo size"],
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Lookups & helpers                                                   */
/* ------------------------------------------------------------------ */

export const totalToolCount = ALL_TOOLS.length;

/**
 * Tools whose implementation ships and is offered in this build.
 * Used by the About page ("X of Y tools are live") — same honesty rule
 * as the announcement banner: count what actually runs, not the roadmap.
 * R23: 3 AI tools deferred → 97 live of 100 registered.
 */
export const liveToolCount = ALL_TOOLS.filter((tool) => tool.enabled).length;

/**
 * Registry-level count of tools visible without admin overrides
 * (R23: 97; /api/tools/status overrides can still disable more on
 * the client).
 */
export const enabledToolCount = ALL_TOOLS.filter(
  (tool) => tool.enabled,
).length;

const toolIndex = new Map(ALL_TOOLS.map((tool) => [tool.id, tool]));

export function getTool(id: string): ToolDef | undefined {
  return toolIndex.get(id);
}

export function getCategory(id: ToolCategoryId): ToolCategory {
  const category = CATEGORIES.find((c) => c.id === id);
  if (!category) throw new Error(`Unknown category: ${id}`);
  return category;
}

export function toolsByCategory(id: ToolCategoryId): ToolDef[] {
  return ALL_TOOLS.filter((tool) => tool.category === id).sort(
    (a, b) => b.popularity - a.popularity
  );
}

/**
 * R23 (owner decision) — the definitive list of AI-dependent tools. Each
 * of these POSTs a bounded text excerpt to a server AI route (/api/chat,
 * /api/summarize or /api/translate). DEFERRED: all three are currently
 * enabled:false (phase P3, future plan) — the R22 warning UI was removed
 * with the deferral. When the AI provider is configured and the tools are
 * re-enabled, restore the warning UI from git history (commit 049e7c6).
 *
 * Keep in sync with src/app/api/{chat,summarize,translate}/route.ts.
 */
export const AI_DEPENDENT_TOOLS: ToolDef[] = ALL_TOOLS.filter(
  (tool) => tool.aiDependent === true,
);

/** True when the tool needs the AI backend to finish its run. */
export function isAiDependent(id: string): boolean {
  return toolIndex.get(id)?.aiDependent === true;
}

/** Top tools by curated popularity (quick tools, popular suggestions). */
export function popularTools(limit: number): ToolDef[] {
  return [...ALL_TOOLS]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);
}

export const PHASE_LABELS: Record<RoadmapPhase, { en: string; hi: string }> = {
  P1: { en: "Phase 1 · MVP", hi: "चरण 1 · एमवीपी" },
  P2: { en: "Phase 2", hi: "चरण 2" },
  P3: { en: "Phase 3", hi: "चरण 3" },
};

/** Tinted chip classes per category color (tokens handle light + dark). */
export const categoryChipClass: Record<CategoryColor, string> = {
  organize: "bg-cat-organize/10 text-cat-organize",
  edit: "bg-cat-edit/10 text-cat-edit",
  convert: "bg-cat-convert/10 text-cat-convert",
  security: "bg-cat-security/10 text-cat-security",
  optimize: "bg-cat-optimize/10 text-cat-optimize",
  create: "bg-cat-create/10 text-cat-create",
  invoices: "bg-cat-invoices/10 text-cat-invoices",
  view: "bg-cat-view/10 text-cat-view",
};

/** Card hover border accent per category color. */
export const categoryHoverClass: Record<CategoryColor, string> = {
  organize: "hover:border-cat-organize/40",
  edit: "hover:border-cat-edit/40",
  convert: "hover:border-cat-convert/40",
  security: "hover:border-cat-security/40",
  optimize: "hover:border-cat-optimize/40",
  create: "hover:border-cat-create/40",
  invoices: "hover:border-cat-invoices/40",
  view: "hover:border-cat-view/40",
};
