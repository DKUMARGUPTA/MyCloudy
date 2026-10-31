/**
 * Tool-level SEO copy (P7-SEO) — titles, descriptions and keywords for
 * every tool page, in English and Hindi.
 *
 * Structure:
 *  - CURATED: hand-written, keyword-researched copy for the ~50 tools with
 *    real search volume (global head terms like "merge pdf" ~1M/mo down to
 *    niche winners like "compress pdf to 100kb"). Titles are ≤ 48 chars so
 *    the " | DocoPDF" suffix keeps the SERP line under ~60.
 *  - generator: the remaining tools get unique copy assembled from their
 *    registry name/description/tags + category noun, with three rotating
 *    privacy tails (deterministic pick — stable SSR output).
 *
 * Rules honored: unique title + description per URL, one intent keyword
 * first in title, numbers/limits kept honest, privacy differentiator
 * ("files never leave your device") present on every tool page because
 * that is the product's #1 competitive moat vs iLovePDF/SmallPDF.
 */

import { ALL_TOOLS } from "@/lib/tools/registry";
import type { ToolDef, ToolCategoryId } from "@/lib/tools/registry";

export interface ToolSeo {
  /** Title WITHOUT the " | DocoPDF" suffix (builder appends). */
  title: string;
  titleHi: string;
  /** 120–160 chars, unique per tool. */
  description: string;
  descriptionHi: string;
  keywords: string[];
  keywordsHi: string[];
}

/* ------------------------------------------------------------------ */
/* Curated, keyword-researched copy (top search-volume tools)          */
/* ------------------------------------------------------------------ */

interface CuratedSeo {
  title: string;
  titleHi?: string;
  description: string;
  descriptionHi?: string;
  keywords: string[];
  keywordsHi?: string[];
}

const CURATED: Record<string, CuratedSeo> = {
  "merge-pdf": {
    title: "Merge PDF Files Online Free — Combine in Seconds",
    titleHi: "PDF जोड़ें — मुफ़्त ऑनलाइन PDF मर्ज टूल",
    description:
      "Combine up to 50 PDF files into one document. Reorder files, pick page ranges and merge PDFs free — no signup, no watermark, files never leave your device.",
    descriptionHi:
      "50 तक PDF फ़ाइलें एक दस्तावेज़ में जोड़ें। क्रम बदलें, पेज चुनें — मुफ़्त, बिना साइनअप, फ़ाइलें आपके डिवाइस पर ही रहती हैं।",
    keywords: [
      "merge pdf",
      "combine pdf",
      "merge pdf files",
      "pdf merger",
      "pdf joiner",
      "combine pdf files into one",
      "merge pdf online free no watermark",
      "पीडीएफ़ जोड़ें",
    ],
    keywordsHi: ["पीडीएफ़ जोड़ें", "pdf merge kaise kare", "पीडीएफ़ मर्ज ऑनलाइन मुफ़्त"],
  },
  "split-pdf": {
    title: "Split PDF Online Free — Divide or Extract Pages",
    titleHi: "PDF बाँटें — मुफ़्त ऑनलाइन PDF स्प्लिटर",
    description:
      "Split one PDF into several files or extract selected pages as a new document. Free online PDF splitter — no signup, no watermark, fully private.",
    keywords: [
      "split pdf",
      "pdf splitter",
      "divide pdf",
      "separate pdf pages",
      "extract pages from pdf",
      "split pdf online free",
      "pdf split and merge",
    ],
  },
  "compress-pdf": {
    title: "Compress PDF Online Free — Reduce PDF File Size",
    titleHi: "PDF कंप्रेस करें — मुफ़्त ऑनलाइन टूल",
    description:
      "Shrink PDF file size with quality presets while keeping text razor sharp. Free PDF compressor — no signup, no email, files processed on your device.",
    descriptionHi:
      "क्वालिटी प्रीसेट से PDF का साइज़ घटाएँ — टेक्स्ट उतना ही साफ़ रहता है। मुफ़्त, बिना साइनअप, फ़ाइलें आपके डिवाइस पर ही।",
    keywords: [
      "compress pdf",
      "reduce pdf size",
      "pdf compressor",
      "compress pdf online free",
      "make pdf smaller",
      "shrink pdf file",
      "pdf size reducer",
      "पीडीएफ़ कंप्रेस",
    ],
    keywordsHi: ["पीडीएफ़ कंप्रेस करें", "pdf ka size kam kare"],
  },
  "compress-pdf-to-size": {
    title: "Compress PDF to Exact Size — 100KB, 200KB, 1MB",
    description:
      "Reduce a PDF to your exact target size — 100 KB, 200 KB, 500 KB or any limit you set. Free, precise and 100% on-device.",
    keywords: [
      "compress pdf to 100kb",
      "compress pdf to 200kb",
      "compress pdf to 1mb",
      "compress pdf to exact size",
      "reduce pdf size to specific size",
      "pdf size limit converter",
    ],
  },
  "edit-pdf": {
    title: "Edit PDF Free Online — Word-Style PDF Editor",
    titleHi: "PDF संपादित करें — मुफ़्त ऑनलाइन एडिटर",
    description:
      "Edit existing PDF text like a document, add images, shapes and signatures, highlight and annotate. Free PDF editor — nothing is ever uploaded.",
    keywords: [
      "edit pdf",
      "pdf editor",
      "edit pdf online free",
      "pdf text editor",
      "edit pdf without acrobat",
      "free pdf editing tools",
      "पीडीएफ़ संपादित करें",
    ],
    keywordsHi: ["पीडीएफ़ एडिट करें", "pdf editor free"],
  },
  "sign-pdf": {
    title: "Sign a PDF Online Free — Draw, Type or Upload",
    titleHi: "PDF पर हस्ताक्षर करें — मुफ़्त ऑनलाइन",
    description:
      "Add your signature to any PDF in seconds — draw it, type it or insert an image. Free e-signing that runs entirely on your device.",
    keywords: [
      "sign pdf",
      "esign pdf",
      "add signature to pdf",
      "electronic signature pdf",
      "sign pdf online free no signup",
      "digital sign document",
    ],
  },
  "lock-pdf": {
    title: "Password Protect a PDF Online Free — Encrypt PDF",
    titleHi: "PDF पर पासवर्ड लगाएँ — मुफ़्त ऑनलाइन",
    description:
      "Add an open password or owner restrictions to a PDF with strong AES encryption. Free PDF locker — no signup, files never leave your device.",
    keywords: [
      "password protect pdf",
      "lock pdf",
      "encrypt pdf",
      "secure pdf with password",
      "add password to pdf free",
      "pdf protection",
    ],
  },
  "unlock-pdf": {
    title: "Unlock PDF Online Free — Remove PDF Password",
    titleHi: "PDF पासवर्ड हटाएँ — मुफ़्त ऑनलाइन",
    description:
      "Remove the password from a PDF you own, with honest permission reporting. Free PDF unlocker — nothing is uploaded, no signup needed.",
    keywords: [
      "unlock pdf",
      "remove pdf password",
      "pdf password remover",
      "decrypt pdf",
      "open protected pdf",
      "unlock pdf online free",
    ],
  },
  "summarize-pdf": {
    title: "Summarize PDF with AI — Free PDF Summarizer",
    titleHi: "PDF सारांश — AI से मुफ़्त समरी टूल",
    description:
      "Get an AI summary of any PDF — key points, chapter breakdown or a quick tldr. Free PDF summarizer that never uploads your document.",
    keywords: [
      "summarize pdf",
      "pdf summarizer",
      "pdf summary ai",
      "tldr pdf",
      "ai pdf reader",
      "summarize pdf online free",
    ],
  },
  "chat-with-pdf": {
    title: "Chat with PDF — Ask Your Document Anything Free",
    titleHi: "PDF से बात करें — मुफ़्त AI चैट",
    description:
      "Talk to any PDF: ask questions, find clauses, get answers with citations. AI chat that runs on your device — your document never leaves the browser.",
    keywords: [
      "chat with pdf",
      "ask pdf questions",
      "ai pdf chat",
      "pdf assistant",
      "chatgpt for pdf free",
      "talk to documents",
    ],
  },
  "rotate-pdf-pages": {
    title: "Rotate PDF Pages Online Free — Save Permanently",
    titleHi: "PDF पेज घुमाएँ — मुफ़्त ऑनलाइन",
    description:
      "Turn pages 90° or 180°, rotate all or selected pages and save the changes permanently. Free, instant and completely private.",
    keywords: [
      "rotate pdf",
      "rotate pdf pages",
      "turn pdf pages",
      "save rotated pdf",
      "rotate pdf online free",
      "fix sideways pdf",
    ],
  },
  "scan-pdf": {
    title: "Scan Documents to PDF Free — Phone Scanner",
    titleHi: "डॉक्यूमेंट स्कैन करें — मुफ़्त कैमरा स्कैनर",
    description:
      "Use your phone camera to scan documents into clean PDFs — auto-crop, deskew and enhance. Free scanner that keeps working offline.",
    keywords: [
      "scan to pdf",
      "document scanner online",
      "phone scanner pdf",
      "camscanner alternative free",
      "scan documents to pdf",
    ],
  },
  "view-pdf": {
    title: "View & Print PDF Online Free — Instant PDF Viewer",
    titleHi: "PDF देखें और प्रिंट करें — मुफ़्त व्यूअर",
    description:
      "Open and read any PDF instantly in the browser — thumbnails, search and print. Free PDF viewer that never uploads your file.",
    keywords: [
      "pdf viewer",
      "view pdf online",
      "read pdf online",
      "open pdf file",
      "pdf reader free",
      "print pdf online",
    ],
  },
  "add-watermark": {
    title: "Add Watermark to PDF Online Free — Text or Image",
    titleHi: "PDF पर वॉटरमार्क लगाएँ — मुफ़्त",
    description:
      "Stamp a text or image watermark on every page — control size, opacity, rotation and position. Free PDF watermarker, fully on-device.",
    keywords: [
      "watermark pdf",
      "add watermark to pdf",
      "pdf stamp",
      "text watermark pdf",
      "image watermark pdf free",
      "pdf watermark online",
    ],
  },
  "ocr-pdf": {
    title: "OCR PDF Online Free — Scans to Searchable Text",
    titleHi: "OCR PDF — स्कैन को खोजने योग्य टेक्स्ट में बदलें",
    description:
      "Convert scanned PDFs into searchable, selectable text with OCR in English or Hindi. Free — no upload, no signup, works offline after load.",
    keywords: [
      "ocr pdf",
      "scanned pdf to text",
      "searchable pdf",
      "pdf text recognition",
      "hindi ocr online",
      "ocr pdf without uploading",
    ],
  },
  "resize-image-kb": {
    title: "Resize Image to Exact KB/MB Online Free",
    description:
      "Resize any photo to an exact file size in KB or MB — perfect for exam forms and uploads. JPG, PNG and WEBP supported, free and private.",
    keywords: [
      "resize image to kb",
      "reduce image size online",
      "compress photo to 100kb",
      "image size reducer",
      "resize jpg to 20kb",
      "photo size converter",
    ],
  },
  "rearrange-pdf-pages": {
    title: "Reorder PDF Pages Online Free — Rearrange & Save",
    description:
      "Drag pages into any order and save the rearranged PDF. Free PDF page reorganizer — visual, instant and completely private.",
    keywords: [
      "reorder pdf pages",
      "rearrange pdf",
      "organize pdf pages",
      "sort pdf pages",
      "change pdf page order",
    ],
  },
  "remove-pdf-pages": {
    title: "Delete Pages from PDF Online Free",
    description:
      "Remove unwanted pages from a PDF and download the clean copy. Free, instant and on-device — no signup, no watermark.",
    keywords: [
      "delete pdf pages",
      "remove pages from pdf",
      "erase pdf pages",
      "cut pages from pdf",
      "delete blank pages pdf",
    ],
  },
  "extract-pdf-pages": {
    title: "Extract PDF Pages Online Free — Save Selection",
    description:
      "Pull selected pages out of a PDF into a new document. Free PDF page extractor — pick ranges visually, download instantly.",
    keywords: [
      "extract pdf pages",
      "pdf page extractor",
      "save certain pages of pdf",
      "separate pages from pdf",
      "pdf cut and paste pages",
    ],
  },
  "reverse-pdf-pages": {
    title: "Reverse PDF Pages Online Free — Flip Page Order",
    description:
      "Reverse the page order of any PDF in one tap — last page becomes first. Free PDF page reverser, processed entirely on your device.",
    keywords: [
      "reverse pdf pages",
      "flip pdf page order",
      "invert pdf pages",
      "reverse page order pdf",
      "backwards pdf",
    ],
  },
  "add-blank-page": {
    title: "Add Blank Page to PDF Online Free",
    description:
      "Insert blank pages into a PDF — at the start, end or after any page, sized to match. Free, instant and on-device.",
    keywords: [
      "add blank page to pdf",
      "insert empty page pdf",
      "add page to pdf",
      "blank page insert pdf",
      "insert page in pdf free",
    ],
  },
  "divide-page": {
    title: "Divide PDF Page Online Free — Split into Columns or Grid",
    description:
      "Cut PDF pages into 2, 3 or 4 pieces — columns, rows or a grid. Content stays sharp and selectable. Free, on-device.",
    keywords: [
      "divide pdf page",
      "split pdf page into parts",
      "cut pdf page in half",
      "pdf page splitter columns",
      "divide pdf into sections",
    ],
  },
  "combine-single-page": {
    title: "Combine PDF into One Page Online Free",
    description:
      "Stitch every page of a PDF into one long page — vertical scroll or horizontal strip. Text stays selectable. Free and on-device.",
    keywords: [
      "combine pdf into one page",
      "merge pdf pages into single page",
      "pdf one long page",
      "stitch pdf pages together",
      "pdf continuous page",
    ],
  },
  "booklet-pdf": {
    title: "Create PDF Booklet Online Free — Saddle-Stitch Order",
    description:
      "Turn any PDF into a print-ready booklet: pages rearranged for fold-and-staple, blanks padded automatically. Free, on-device.",
    keywords: [
      "pdf booklet maker",
      "create booklet from pdf",
      "saddle stitch pdf",
      "pdf booklet printing",
      "fold and staple pdf",
    ],
  },
  "sanitize-pdf": {
    title: "Sanitize PDF Online Free — Remove Hidden Data",
    description:
      "One tap strips comments, links, form fields, metadata, hidden page data and embedded scripts from a PDF. Free and on-device.",
    keywords: [
      "sanitize pdf",
      "clean pdf metadata and annotations",
      "remove hidden data pdf",
      "strip pdf annotations",
      "pdf privacy clean",
    ],
  },
  "bates-numbering": {
    title: "Bates Numbering PDF Online Free — Legal Page Stamps",
    description:
      "Stamp legal Bates numbers (DOC-000001…) across your PDF — prefix, padding, start number and position. Free, on-device, never uploaded.",
    keywords: [
      "bates numbering pdf",
      "bates stamp online",
      "legal pdf numbering",
      "add bates numbers",
      "law firm pdf stamp",
    ],
  },
  "add-stamps": {
    title: "Add Stamp to PDF Online Free — APPROVED, DRAFT, CONFIDENTIAL",
    description:
      "Rubber-stamp your PDF — APPROVED, DRAFT, CONFIDENTIAL or your own word, in any corner, tilted and translucent. Free and on-device.",
    keywords: [
      "add stamp to pdf",
      "approved stamp pdf",
      "draft stamp pdf",
      "confidential stamp pdf",
      "pdf rubber stamp online",
    ],
  },
  "background-color": {
    title: "PDF Background Color Online Free — Fill Page Background",
    description:
      "Fill PDF pages with ivory, yellow, mint or any hex color — placed behind the text so it stays readable. Free and on-device.",
    keywords: [
      "pdf background color",
      "change pdf page background",
      "add background to pdf",
      "color pdf pages online",
      "pdf page fill color",
    ],
  },
  "remove-blank-pages": {
    title: "Remove Blank Pages from PDF Online Free",
    description:
      "Detect and delete truly blank PDF pages — no text, no drawings, no images — in one pass. Free, on-device, never uploaded.",
    keywords: [
      "remove blank pages from pdf",
      "delete empty pdf pages",
      "blank page remover",
      "clean blank pages pdf",
      "strip blank pages",
    ],
  },
  "alternate-merge": {
    title: "Alternate Merge PDF Online Free — Interleave Two PDFs",
    description:
      "Weave two PDFs page by page (A1, B1, A2, B2…) — the fix for front/back duplex scans. Free, on-device, byte-exact pages.",
    keywords: [
      "alternate merge pdf",
      "interleave pdf pages",
      "merge two pdfs alternately",
      "odd even pdf merge",
      "front back scan combine",
    ],
  },
  "add-page-labels": {
    title: "Add Page Labels to PDF Online Free — Logical Numbering",
    description:
      "Set the logical page labels viewers display — 1, 2, 3 or i, ii, iii or A, B, C — with a prefix and start number. Free and on-device.",
    keywords: [
      "pdf page labels",
      "add page labels pdf",
      "pdf logical numbering",
      "roman numerals pdf pages",
      "pdf page label prefix",
    ],
  },
  "invert-pdf-colors": {
    title: "Invert PDF Colors Online Free — Negative PDF",
    description:
      "Flip every color in your PDF — white pages turn black, text turns light — the photographic negative. Pick DPI and pages. Free, on-device.",
    keywords: [
      "invert pdf colors",
      "negative pdf",
      "invert colors pdf online",
      "dark mode pdf",
      "flip pdf colors",
    ],
  },
  "pdf-to-greyscale": {
    title: "Convert PDF to Grayscale Online Free",
    description:
      "Turn color PDF pages into clean eye-weighted greyscale — printer-friendly, ink-saving, text stays sharp. Free and fully on-device.",
    keywords: [
      "convert pdf to grayscale",
      "pdf to greyscale",
      "black and white pdf",
      "make pdf grayscale online",
      "remove color from pdf",
    ],
  },
  "scanner-effect": {
    title: "Make PDF Look Scanned — Free Scanner Effect",
    description:
      "Give crisp digital pages a flatbed-scanner look — grain, contrast crunch, optional warm lamp tint. Free, on-device, never uploaded.",
    keywords: [
      "make pdf look scanned",
      "scanner effect pdf",
      "fake scanned pdf",
      "pdf scan filter online",
      "scanned document look",
    ],
  },
  "posterize-pdf": {
    title: "Posterize PDF Online Free — Flat Color Levels",
    description:
      "Snap PDF colors to 2-8 flat levels per channel — the bold screen-print poster look. PNG mode keeps exact levels. Free and on-device.",
    keywords: [
      "posterize pdf",
      "reduce colors pdf",
      "flat colors pdf",
      "poster effect pdf online",
      "posterization tool",
    ],
  },
  "add-page-numbers": {
    title: "Add Page Numbers to PDF Online Free",
    description:
      "Number PDF pages your way — position, format, start value and margins. Free PDF page numberer, processed entirely on your device.",
    keywords: [
      "add page numbers to pdf",
      "pdf page numbering",
      "number pdf pages",
      "insert page numbers in pdf",
      "pdf page numbers online free",
    ],
  },
  "crop-pdf": {
    title: "Crop PDF Online Free — Trim Margins & Edges",
    description:
      "Crop PDF pages to trim margins or resize the visible area — one crop for all or per-page control. Free, instant, files stay private.",
    keywords: [
      "crop pdf",
      "trim pdf margins",
      "cut pdf edges",
      "resize pdf page",
      "pdf crop tool free",
    ],
  },
  "create-invoice": {
    title: "Free Invoice Generator — Create PDF Invoices",
    titleHi: "मुफ़्त इनवॉइस जेनरेटर — PDF बिल बनाएँ",
    description:
      "Build professional invoices with GST, logo and auto totals in seconds — download as PDF. Free invoice maker, your data never uploaded.",
    keywords: [
      "invoice generator",
      "free invoice maker",
      "gst invoice format",
      "create invoice pdf",
      "billing software free",
      "invoice template india",
    ],
  },
  "create-resume": {
    title: "Free Resume Builder — ATS-Friendly PDF Resumes",
    description:
      "Create a clean, recruiter-friendly resume and download it as PDF. Free ATS resume maker with templates that pass parser checks.",
    keywords: [
      "resume builder free",
      "ats resume maker",
      "make resume pdf",
      "cv maker online free",
      "free resume templates",
    ],
  },
  "add-header-footer": {
    title: "Add Header & Footer to PDF Online Free",
    description:
      "Put headers and footers on every PDF page — dates, titles, page numbers and custom text. Free, private and instant.",
    keywords: [
      "pdf header footer",
      "add header to pdf",
      "add footer to pdf",
      "pdf running title",
      "pdf header and page number",
    ],
  },
  "create-pdf": {
    title: "Create a PDF Online Free — Blank or Custom Pages",
    description:
      "Create PDFs from scratch — pick page size, page count and ruling. Free PDF creator that keeps working offline after load.",
    keywords: [
      "create pdf",
      "new pdf document",
      "blank pdf",
      "pdf creator online free",
      "make a pdf online",
    ],
  },
  "redact-pdf": {
    title: "Redact PDF Online Free — Black Out Text for Good",
    description:
      "True redaction: sensitive text and images are removed permanently, not just covered. Free PDF redaction tool — 100% private, nothing uploaded.",
    keywords: [
      "redact pdf",
      "black out pdf text",
      "remove sensitive information from pdf",
      "pdf redaction free",
      "censor pdf",
    ],
  },
  "write-pdf": {
    title: "Write PDF Online Free — Type & Export Documents",
    titleHi: "PDF लिखें — मुफ़्त टाइप और एक्सपोर्ट",
    description:
      "Write documents in a rich editor and export as PDF — full Devanagari support for Hindi. Free PDF writer with no watermarks.",
    keywords: [
      "write pdf",
      "type pdf document",
      "pdf writer online free",
      "create text pdf",
      "hindi pdf typing",
    ],
  },
  "generate-password": {
    title: "Strong Password Generator — Free, Secure, Offline",
    description:
      "Generate strong random passwords with custom rules — length, symbols, look-alike filtering. Free generator that runs fully in your browser.",
    keywords: [
      "password generator",
      "strong password generator",
      "random password",
      "secure password creator",
      "password generator free",
    ],
  },
  "annotate-pdf": {
    title: "Annotate PDF Online Free — Highlights, Notes, Shapes",
    description:
      "Highlight text, add sticky notes, draw shapes and freehand marks on any PDF. Free PDF annotator — private and watermark-free.",
    keywords: [
      "annotate pdf",
      "pdf highlighter",
      "add notes to pdf",
      "pdf annotation free",
      "mark up pdf",
      "pdf sticky notes",
    ],
  },
  "copy-from-pdf": {
    title: "Copy Text from PDF Online Free",
    description:
      "Select and copy text out of any PDF — even from scanned pages via OCR. Free, instant, nothing uploaded.",
    keywords: [
      "copy text from pdf",
      "copy from pdf to word",
      "extract text from pdf",
      "pdf text copier",
      "copy pdf content",
    ],
  },
  "webpage-to-pdf": {
    title: "Webpage to PDF Converter Online Free",
    description:
      "Save any web page as a clean, selectable-text PDF. Free URL-to-PDF converter — your links and reading stay private.",
    keywords: [
      "webpage to pdf",
      "url to pdf",
      "save website as pdf",
      "web page to pdf converter free",
      "html page to pdf",
    ],
  },
  "extract-images": {
    title: "Extract Images from PDF Online Free",
    description:
      "Pull every embedded image out of a PDF at original quality. Free PDF image extractor — instant download, fully private.",
    keywords: [
      "extract images from pdf",
      "pdf image extractor",
      "save pictures from pdf",
      "get images out of pdf",
      "pdf to images",
    ],
  },
  "repair-pdf": {
    title: "Repair Corrupted PDF Online Free — Recover Files",
    description:
      "Fix damaged or truncated PDFs and recover every readable page. Free PDF repair tool that rebuilds files on your device.",
    keywords: [
      "repair pdf",
      "fix corrupted pdf",
      "recover damaged pdf",
      "pdf repair tool free",
      "restore pdf file",
    ],
  },
  "translate-pdf": {
    title: "Translate PDF Online Free — 13+ Languages",
    titleHi: "PDF अनुवाद — 13+ भाषाएँ, मुफ़्त",
    description:
      "Translate PDF documents into Hindi, English, Spanish, Arabic and more — bilingual or translated-only output. Free and fully private.",
    keywords: [
      "translate pdf",
      "pdf translator",
      "translate pdf to english",
      "translate pdf to hindi",
      "document translation free",
    ],
  },
  "web-optimize-pdf": {
    title: "Optimize PDF for Web — Free PDF Optimizer",
    description:
      "Slim PDFs for the web — pack object streams, strip metadata and drop unreferenced objects. Free PDF optimizer, on-device.",
    keywords: [
      "optimize pdf for web",
      "pdf optimizer",
      "linearize pdf",
      "reduce pdf objects",
      "fast loading pdf",
    ],
  },
  "jpg-to-pdf": {
    title: "JPG to PDF Converter Online Free — No Watermark",
    titleHi: "JPG से PDF — मुफ़्त कन्वर्टर, बिना वॉटरमार्क",
    description:
      "Convert JPG photos to PDF — reorder, rotate and choose page size. Free image-to-PDF converter, no signup, no watermark, fully private.",
    descriptionHi:
      "JPG फोटो को PDF में बदलें — क्रम बदलें, घुमाएँ, पेज साइज़ चुनें। मुफ़्त, बिना साइनअप और बिना वॉटरमार्क।",
    keywords: [
      "jpg to pdf",
      "jpeg to pdf",
      "photo to pdf",
      "image to pdf converter",
      "jpg to pdf online free no watermark",
      "फोटो को pdf में बदलें",
    ],
    keywordsHi: ["फोटो से पीडीएफ़", "jpg to pdf hindi"],
  },
  "pdf-to-jpg": {
    title: "PDF to JPG Converter Online Free — High Quality",
    titleHi: "PDF से JPG — मुफ़्त हाई-क्वालिटी कन्वर्टर",
    description:
      "Turn PDF pages into high-quality JPG images at any DPI. Free PDF-to-image converter — nothing uploaded, no signup, no limits.",
    keywords: [
      "pdf to jpg",
      "pdf to image",
      "convert pdf to jpeg",
      "pdf to photo",
      "pdf to jpg online free high quality",
    ],
  },
  "word-to-pdf": {
    title: "Word to PDF Converter Online Free",
    titleHi: "Word से PDF — मुफ़्त ऑनलाइन कन्वर्टर",
    description:
      "Convert DOC and DOCX files to PDF with formatting kept intact. Free Word-to-PDF converter — files never leave your device.",
    keywords: [
      "word to pdf",
      "docx to pdf",
      "doc to pdf converter",
      "word to pdf online free",
      "word to pdf no watermark",
    ],
  },
  "pdf-to-word": {
    title: "PDF to Word Converter — Free & On-Device",
    titleHi: "PDF से Word — मुफ़्त, प्राइवेट कन्वर्टर",
    description:
      "Convert PDFs into editable Word documents with tables and styles. Free PDF-to-DOCX converter, runs fully on your device.",
    keywords: [
      "pdf to word",
      "pdf to docx",
      "convert pdf to word free",
      "pdf to editable word",
      "pdf to word without upload",
    ],
  },
  "excel-to-pdf": {
    title: "Excel to PDF Converter Online Free",
    description:
      "Convert XLSX spreadsheets to clean PDFs — sheets, gridlines and print areas. Free, private, no signup.",
    keywords: [
      "excel to pdf",
      "xlsx to pdf",
      "spreadsheet to pdf",
      "excel to pdf converter free",
    ],
  },
  "pdf-to-excel": {
    title: "PDF to Excel Converter — Extract Tables Free",
    description:
      "Pull tables out of PDFs into editable XLSX spreadsheets with ruled-table detection. Free PDF-to-Excel converter, runs on your device.",
    keywords: [
      "pdf to excel",
      "pdf table to excel",
      "extract tables from pdf",
      "pdf to xlsx converter free",
    ],
  },
  "powerpoint-to-pdf": {
    title: "PowerPoint to PDF Converter Online Free",
    description:
      "Convert PPTX slide decks to PDF for easy sharing and printing. Free, private, no watermark.",
    keywords: [
      "powerpoint to pdf",
      "pptx to pdf",
      "slides to pdf converter free",
    ],
  },
  "pdf-to-powerpoint": {
    title: "PDF to PowerPoint Converter — Free & Private",
    description:
      "Turn PDF pages into editable PPTX slides. Free PDF-to-PowerPoint converter, processed entirely on your device.",
    keywords: [
      "pdf to powerpoint",
      "pdf to pptx",
      "convert pdf to slides",
    ],
  },
  "images-to-pdf": {
    title: "Images to PDF — JPG, PNG, WEBP, HEIC in One File",
    description:
      "Combine many images into one PDF — any format, reorder, margins and page size. Free multi-image-to-PDF converter, fully private.",
    keywords: [
      "images to pdf",
      "multiple images to one pdf",
      "photos to pdf converter",
      "picture to pdf",
      "combine jpg into pdf",
    ],
  },
  "heic-to-jpg": {
    title: "HEIC to JPG Converter Online Free",
    description:
      "Convert iPhone HEIC photos to JPG with quality control and batch mode. Free converter that works without uploading.",
    keywords: [
      "heic to jpg",
      "heic converter",
      "iphone photo to jpg",
      "convert heic to jpeg free",
    ],
  },
  "html-to-pdf": {
    title: "HTML to PDF Converter Online Free",
    description:
      "Convert HTML files to clean, print-ready PDFs. Free HTML-to-PDF converter — no signup, fully on-device.",
    keywords: ["html to pdf", "html file to pdf", "web file to pdf converter free"],
  },
  "markdown-to-pdf": {
    title: "Markdown to PDF Converter Online Free",
    description:
      "Render Markdown into beautifully-typeset PDFs with code blocks and tables. Free MD-to-PDF converter, completely private.",
    keywords: ["markdown to pdf", "md to pdf", "markdown converter free"],
  },
  "epub-to-pdf": {
    title: "EPUB to PDF Converter Online Free",
    description:
      "Convert EPUB ebooks to PDF with proper pagination. Free ebook converter — your library stays on your device.",
    keywords: ["epub to pdf", "ebook to pdf", "epub converter free"],
  },
  "pdf-to-txt": {
    title: "PDF to Text Converter Online Free",
    description:
      "Extract all text from a PDF into a clean TXT file — selected pages or the whole document. Free, private, instant.",
    keywords: [
      "pdf to text",
      "pdf to txt",
      "extract text from pdf",
      "pdf text extractor free",
    ],
  },
  "passport-photo": {
    title: "Passport Photo Maker Online Free — 35+ Sizes",
    description:
      "Create passport, visa and ID photos with correct sizes and backgrounds — print-ready sheets. Free photo maker, on-device.",
    keywords: [
      "passport photo maker",
      "passport size photo online",
      "id photo creator",
      "visa photo tool free",
      "photo resize for passport",
    ],
  },
  "generate-qr-code": {
    title: "Free QR Code Generator — PNG, SVG & PDF",
    description:
      "Create QR codes for links, text, Wi-Fi and more — download as PNG, SVG or printable PDF. Free generator, no signup.",
    keywords: [
      "qr code generator",
      "create qr code free",
      "qr generator online",
      "custom qr code",
    ],
  },
  "fill-out-pdf": {
    title: "Fill Out PDF Forms Online Free",
    description:
      "Type into any PDF form — text fields, checkboxes, dropdowns — and save or print. Free PDF form filler, fully private.",
    keywords: [
      "fill out pdf form",
      "pdf form filler free",
      "fill pdf forms online",
      "type on pdf",
    ],
  },
  "make-pdf-fillable": {
    title: "Make a PDF Fillable — Add Form Fields Free",
    description:
      "Turn a plain PDF into a fillable form — add text fields, checkboxes and dropdowns where you want them. Free and on-device.",
    keywords: [
      "make pdf fillable",
      "create fillable pdf form free",
      "add form fields to pdf",
      "editable pdf form",
    ],
  },
  "search-pdf": {
    title: "Search Inside PDF Files Online Free",
    description:
      "Find every occurrence of a word or phrase across a PDF — with page jumps and counts. Free PDF search, fully private.",
    keywords: ["search pdf", "find text in pdf", "pdf word search", "search in pdf online"],
  },
  "compare-pdf": {
    title: "Compare Two PDFs Online Free — Side by Side",
    description:
      "See two PDFs side by side with paired pages — spot every difference visually. Free PDF comparison tool, nothing uploaded.",
    keywords: ["compare pdf", "pdf diff", "compare two pdf files", "pdf comparison free"],
  },
  "flatten-pdf": {
    title: "Flatten PDF Form Fields Online Free",
    description:
      "Lock filled form values and annotations into the page so they can't be edited. Free PDF flattener, fully on-device.",
    keywords: ["flatten pdf", "flatten pdf form", "lock pdf form fields", "pdf flattener free"],
  },
  "bookmark-pdf": {
    title: "Add Bookmarks to PDF Online Free — PDF Outline",
    description:
      "Build a clickable table-of-contents outline for any PDF — one bookmark per page or your own tree. Free and private.",
    keywords: ["pdf bookmarks", "add bookmarks to pdf", "pdf outline", "pdf table of contents"],
  },
} as const;

/* ------------------------------------------------------------------ */
/* Category-level SEO                                                  */
/* ------------------------------------------------------------------ */

export interface CategorySeo {
  title: string;
  titleHi: string;
  description: string;
  descriptionHi: string;
  keywords: string[];
}

const CATEGORY_SEO: Record<ToolCategoryId, CategorySeo> = {
  organize: {
    title: "Organize PDF Tools — Merge, Split, Reorder Pages Free",
    titleHi: "PDF व्यवस्था टूल्स — जोड़ें, बाँटें, क्रम बदलें",
    description:
      "Merge, split, reorder, rotate, extract and delete PDF pages — 12 free organizing tools, all on your device. No signup, no watermark.",
    descriptionHi:
      "PDF पेज जोड़ें, बाँटें, क्रम बदलें, घुमाएँ — 12 मुफ़्त टूल, सब आपके डिवाइस पर। बिना साइनअप।",
    keywords: ["pdf organizer", "merge and split pdf", "rearrange pdf pages", "pdf page tools"],
  },
  "convert-to": {
    title: "Convert to PDF — Word, Excel, JPG, HTML to PDF Free",
    titleHi: "PDF में बदलें — Word, Excel, JPG से PDF",
    description:
      "17 free converters into PDF — Word, Excel, PowerPoint, JPG, PNG, WEBP, HEIC, SVG, HTML, Markdown, EPUB and more. Nothing uploaded.",
    descriptionHi:
      "17 मुफ़्त कन्वर्टर — Word, Excel, PowerPoint, फोटो, HTML, Markdown से PDF में। बिना अपलोड।",
    keywords: [
      "convert to pdf",
      "word to pdf",
      "jpg to pdf",
      "excel to pdf",
      "documents to pdf free",
    ],
  },
  "convert-from": {
    title: "Convert from PDF — to Word, JPG, Excel, Text Free",
    titleHi: "PDF से बदलें — Word, JPG, Excel, टेक्स्ट",
    description:
      "14 free converters out of PDF — to Word, Excel, PowerPoint, JPG, PNG, WEBP, SVG, TIFF, HTML, Markdown, text and more. Fully private.",
    descriptionHi:
      "14 मुफ़्त कन्वर्टर — PDF से Word, Excel, फोटो, HTML, टेक्स्ट में। पूरी प्राइवेसी।",
    keywords: ["pdf to word", "pdf to jpg", "pdf converter", "pdf to excel", "convert pdf free"],
  },
  edit: {
    title: "Edit PDF Tools — Watermark, Crop, Numbers, Metadata",
    titleHi: "PDF संपादन टूल्स — वॉटरमार्क, क्रॉप, नंबर",
    description:
      "11 free PDF editing tools — the Word-style editor plus watermark, page numbers, headers, crop, metadata and form fields. On-device.",
    descriptionHi:
      "11 मुफ़्त संपादन टूल — एडिटर, वॉटरमार्क, पेज नंबर, क्रॉप, मेटाडेटा। सब डिवाइस पर।",
    keywords: ["pdf editing tools", "edit pdf free", "pdf watermark", "pdf tools online"],
  },
  create: {
    title: "Create PDFs — Documents, Resumes, Invoices, QR Codes",
    titleHi: "PDF बनाएँ — दस्तावेज़, रिज़्यूमे, इनवॉइस",
    description:
      "10 free creators — blank PDFs, written documents, resumes, photo collages, cards, QR codes and scans. No signup, fully on-device.",
    descriptionHi:
      "10 मुफ़्त क्रिएटर — ख़ाली PDF, दस्तावेज़, रिज़्यूमे, कोलाज, कार्ड, QR कोड। बिना साइनअप।",
    keywords: ["create pdf online", "pdf maker free", "resume builder", "qr code generator"],
  },
  view: {
    title: "View & Understand PDFs — Read, Search, Summarize, Chat",
    titleHi: "PDF देखें — पढ़ें, खोजें, समराइज़ करें",
    description:
      "8 free viewing tools — instant viewer, search, copy, compare, AI summarize and chat with any PDF. Your documents stay private.",
    descriptionHi:
      "8 मुफ़्त टूल — व्यूअर, सर्च, कॉपी, AI समरी और PDF से चैट। दस्तावेज़ प्राइवेट रहते हैं।",
    keywords: ["pdf viewer", "summarize pdf", "chat with pdf", "read pdf online"],
  },
  security: {
    title: "PDF Security — Sign, Encrypt, Redact, Verify Free",
    titleHi: "PDF सुरक्षा — साइन, एन्क्रिप्ट, रिडैक्ट",
    description:
      "8 free security tools — sign and verify signatures, password-protect, unlock, true redaction and metadata cleanup. Nothing uploaded.",
    descriptionHi:
      "8 मुफ़्त सुरक्षा टूल — हस्ताक्षर, पासवर्ड, रिडैक्शन, मेटाडेटा क्लीनअप। बिना अपलोड।",
    keywords: ["sign pdf", "password protect pdf", "redact pdf", "pdf security tools"],
  },
  optimize: {
    title: "Optimize PDFs — Compress, Repair, Flatten, PDF/A",
    titleHi: "PDF ऑप्टिमाइज़ — कंप्रेस, रिपेयर, फ्लैटन",
    description:
      "8 free optimization tools — compress to any size, repair damaged files, flatten forms, PDF/A conversion and web optimization.",
    descriptionHi:
      "8 मुफ़्त टूल — किसी भी साइज़ में कंप्रेस, रिपेयर, फ्लैटन, PDF/A कन्वर्ज़न।",
    keywords: ["compress pdf", "repair pdf", "pdf to pdfa", "optimize pdf"],
  },
  invoices: {
    title: "Invoice Tools — GST Invoices & E-Invoice (Factur-X)",
    titleHi: "इनवॉइस टूल्स — GST बिल और ई-इनवॉइस",
    description:
      "6 free invoice tools — GST invoice generator, Factur-X/EN 16931 electronic invoices and validation. Built for Indian businesses.",
    descriptionHi:
      "6 मुफ़्त टूल — GST इनवॉइस, Factur-X ई-इनवॉइस और वैलिडेशन। भारतीय व्यापार के लिए।",
    keywords: ["gst invoice generator", "e invoice format", "factur-x", "electronic invoice india"],
  },
  images: {
    title: "Image Tools — Resize to KB, Passport Photos, Convert",
    titleHi: "इमेज टूल्स — KB में रिसाइज़, पासपोर्ट फोटो",
    description:
      "6 free image tools — resize photos to exact KB/MB, make passport photos and convert HEIC/WEBP formats. Private, no upload.",
    descriptionHi:
      "6 मुफ़्त टूल — फोटो साइज़ KB/MB में, पासपोर्ट फोटो, HEIC/WEBP कन्वर्ट। बिना अपलोड।",
    keywords: ["resize image online", "photo to kb", "passport photo", "image converter free"],
  },
};

/* ------------------------------------------------------------------ */
/* Generator for the remaining tools                                   */
/* ------------------------------------------------------------------ */

const CATEGORY_NOUN: Record<ToolCategoryId, string> = {
  organize: "PDF Tool",
  "convert-to": "PDF Converter",
  "convert-from": "PDF Converter",
  edit: "PDF Tool",
  create: "PDF Creator",
  view: "PDF Tool",
  security: "PDF Tool",
  optimize: "PDF Tool",
  invoices: "Invoice Tool",
  images: "Image Tool",
};

const EN_TAILS = [
  " Free — no signup, files stay on your device.",
  " Free online, no signup — fully on-device and private.",
  " Free — no watermark, no upload, runs on your device.",
] as const;

const HI_TAILS = [
  " मुफ़्त — बिना साइनअप, फ़ाइलें आपके डिवाइस पर ही रहती हैं।",
  " मुफ़्त ऑनलाइन — पूरी प्राइवेसी, बिना अपलोड।",
  " मुफ़्त — बिना वॉटरमार्क, आपके डिवाइस पर ही।",
] as const;

function capitalize(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}

function stablePick<T>(items: readonly T[], key: string): T {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 997;
  }
  return items[hash % items.length];
}

function buildGeneratedSeo(tool: ToolDef): ToolSeo {
  const noun = CATEGORY_NOUN[tool.category];
  const en = tool.description.en.replace(/\.$/, "");
  const hi = tool.description.hi.replace(/\.$/, "");
  const baseKeywords = [
    tool.name.en.toLowerCase(),
    `${tool.name.en.toLowerCase()} online free`,
    ...tool.tags.en,
  ].slice(0, 8);
  return {
    title: `${tool.name.en} — Free Online ${noun}`,
    titleHi: `${tool.name.hi} — मुफ़्त ऑनलाइन ${noun === "PDF Converter" ? "कन्वर्टर" : "टूल"}`,
    description: `${capitalize(en)}.${stablePick(EN_TAILS, tool.id)}`,
    descriptionHi: `${hi}।${stablePick(HI_TAILS, tool.id)}`,
    keywords: baseKeywords,
    keywordsHi: tool.tags.hi.slice(0, 6),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const SEO_CACHE = new Map<string, ToolSeo>();

function buildToolSeo(tool: ToolDef): ToolSeo {
  const curated = (CURATED as Record<string, CuratedSeo | undefined>)[tool.id];
  if (!curated) return buildGeneratedSeo(tool);
  const generated = buildGeneratedSeo(tool);
  return {
    title: curated.title,
    titleHi: curated.titleHi ?? generated.titleHi,
    description: curated.description,
    descriptionHi: curated.descriptionHi ?? generated.descriptionHi,
    keywords: curated.keywords,
    keywordsHi: curated.keywordsHi ?? generated.keywordsHi,
  };
}

/** SEO copy for a tool id (cached). Falls back to generated copy. */
export function getToolSeo(toolId: string): ToolSeo | undefined {
  const cached = SEO_CACHE.get(toolId);
  if (cached) return cached;

  const tool = ALL_TOOLS.find((t) => t.id === toolId && t.enabled);
  if (!tool) return undefined;

  const seo = buildToolSeo(tool);
  SEO_CACHE.set(toolId, seo);
  return seo;
}

/** Category landing-page SEO copy. */
export function getCategorySeo(categoryId: string): CategorySeo | undefined {
  return (CATEGORY_SEO as Record<string, CategorySeo | undefined>)[categoryId];
}

/** Static content-page SEO copy. */
export const STATIC_PAGE_SEO: Record<
  string,
  { title: string; titleHi: string; description: string; descriptionHi: string }
> = {
  about: {
    title: "About DocoPDF — Private, On-Device PDF Tools",
    titleHi: "DocoPDF के बारे में — प्राइवेट PDF टूल्स",
    description:
      "DocoPDF builds 100 free PDF tools that run entirely in your browser — private by design, bilingual (English + हिंदी), no signup. Meet the team and mission.",
    descriptionHi:
      "DocoPDF — 100 मुफ़्त PDF टूल, पूरी तरह ब्राउज़र में। प्राइवेट, द्विभाषी, बिना साइनअप।",
  },
  contact: {
    title: "Contact DocoPDF — Support & Feedback",
    titleHi: "संपर्क करें — सहायता और फ़ीडबैक",
    description:
      "Questions, bug reports or feature ideas for DocoPDF? Contact us — we read every message and reply fast.",
    descriptionHi:
      "सवाल, बग रिपोर्ट या सुझाव? हमसे संपर्क करें — हम हर संदेश पढ़ते हैं।",
  },
  privacy: {
    title: "Privacy Policy — Your Files Never Leave Your Device",
    titleHi: "गोपनीयता नीति — फ़ाइलें डिवाइस से बाहर नहीं जातीं",
    description:
      "DocoPDF privacy policy: PDF processing happens on your device. What we store (almost nothing) and why — the honest, plain-language version.",
    descriptionHi:
      "DocoPDF गोपनीयता नीति: PDF प्रोसेसिंग आपके डिवाइस पर होती है। ईमानदार, सरल भाषा में।",
  },
  terms: {
    title: "Terms of Service — DocoPDF",
    titleHi: "सेवा की शर्तें — DocoPDF",
    description:
      "The plain-language terms for using DocoPDF's 100 free on-device PDF tools.",
    descriptionHi: "DocoPDF के 100 मुफ़्त PDF टूल्स की सरल शर्तें।",
  },
};
