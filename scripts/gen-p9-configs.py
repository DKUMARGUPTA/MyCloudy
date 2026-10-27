#!/usr/bin/env python3
"""Generate P9 server-convert tool configs + i18n how-keys."""
import json, os

TOOLS = {
  "word-to-pdf": ("pdf", "word2pdf", ["view-pdf", "merge-pdf"],
    [("Word files (.doc, .docx) become clean PDFs with layout and fonts kept close to the original.", "Word फ़ाइलें (.doc, .docx) साफ़ PDF बनती हैं — लेआउट और फ़ॉन्ट मूल के क़रीब रहते हैं।"),
     ("Several files at once — each becomes its own PDF.", "कई फ़ाइलें एक साथ — हर एक की अपनी PDF।"),
     ("Server-assisted conversion — this one tool sends your file to Sidocs's own converter. Nothing else, no third party.", "सर्वर-सहायता वाला रूपांतरण — सिर्फ़ यह एक टूल आपकी फ़ाइल Sidocs के अपने कन्वर्टर तक भेजता है। और कहीं नहीं, कोई तीसरा पक्ष नहीं।"),
     ("Output is a normal PDF you can edit, sign or merge with the other tools.", "आउटपुट सामान्य PDF है — दूसरे टूल्स से एडिट, साइन या मर्ज कर सकते हैं।")],
    [("How close is the layout to the original?", "लेआउट मूल से कितना मिलता है?"),
     ("LibreOffice does the rendering — most documents (letters, reports, resumes) look right; heavy templates with exotic fonts may shift slightly. Always check the preview.", "LibreOffice रेंडरिंग करता है — ज़्यादातर दस्तावेज़ (पत्र, रिपोर्ट, रिज़्यूमे) सही दिखते हैं; अजीब फ़ॉन्ट वाले भारी टेम्पलेट थोड़े खिसक सकते हैं। प्रीव्यू ज़रूर देखें।"),
     ("Is my file uploaded anywhere?", "क्या मेरी फ़ाइल कहीं अपलोड होती है?"),
     ("Yes — but only to Sidocs's own conversion service on this site, for the seconds the conversion takes. No third party, no storage, no sharing.", "हाँ — लेकिन सिर्फ़ Sidocs के अपने कन्वर्ज़न सर्विस तक, सिर्फ़ रूपांतरण के सेकंड भर के लिए। कोई तीसरा पक्ष नहीं, कोई स्टोरेज नहीं।")], 5),
  "excel-to-pdf": ("pdf", "excel2pdf", ["view-pdf", "merge-pdf"],
    [("Spreadsheets (.xls, .xlsx, .ods, .csv) become printable PDFs.", "स्प्रेडशीट (.xls, .xlsx, .ods, .csv) प्रिंट करने लायक़ PDF बनती हैं।"),
     ("Wide sheets split across pages sensibly.", "चौड़ी शीट पेजों पर समझदारी से बँटती हैं।"),
     ("Server-assisted — the file goes to Sidocs's own converter only, for the conversion itself.", "सर्वर-सहायता — फ़ाइल सिर्फ़ रूपांतरण के लिए Sidocs के अपने कन्वर्टर तक जाती है।")],
    [("Do formulas and charts survive?", "फ़ॉर्मूला और चार्ट बचते हैं?"),
     ("Calculated values print as values; charts render as they looked when saved. If the sheet is very wide, check the page splits in the preview.", "गणना के मान वैसे ही छपते हैं जैसे सेव थे; चार्ट सेव होने के समय जैसे दिखते थे वैसे रेंडर होते हैं। शीट बहुत चौड़ी हो तो प्रीव्यू में पेज-बँटवारा देख लें।")], 5),
  "powerpoint-to-pdf": ("pdf", "ppt2pdf", ["view-pdf", "merge-pdf"],
    [("Slides (.ppt, .pptx, .odp) become share-ready PDFs.", "स्लाइड (.ppt, .pptx, .odp) शेयर करने लायक़ PDF बनती हैं।"),
     ("One PDF page per slide.", "हर स्लाइड की एक PDF पेज।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Are animations kept?", "एनिमेशन रहते हैं?"),
     ("No — PDF is a static format, so each slide prints as it looked. Animations and transitions are naturally lost.", "नहीं — PDF स्थिर फ़ॉर्मैट है, हर स्लाइड वैसी छपती है जैसी दिखती थी। एनिमेशन और ट्रांज़िशन स्वाभाविक रूप से चले जाते हैं।")], 5),
  "odt-to-pdf": ("pdf", "odt2pdf", ["view-pdf", "merge-pdf"],
    [("OpenDocument text (.odt) files become PDFs — handy when sharing with people who only have MS Office.", "OpenDocument टेक्स्ट (.odt) फ़ाइलें PDF बनती हैं — सिर्फ़ MS Office वालों से शेयर करने में आसान।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Why .odt instead of .docx?", ".docx की जगह .odt क्यों?"),
     (".odt is the open standard from LibreOffice/Google Docs exports; this tool makes it universally readable as PDF.", ".odt LibreOffice/Google Docs एक्सपोर्ट का खुला स्टैंडर्ड है; यह टूल इसे सबके लिए पढ़ने लायक़ PDF बना देता है।")], 5),
  "rtf-to-pdf": ("pdf", "rtf2pdf", ["view-pdf", "merge-pdf"],
    [("Old Rich Text files (.rtf) become clean PDFs.", "पुरानी Rich Text फ़ाइलें (.rtf) साफ़ PDF बनती हैं।"),
     ("Basic formatting — bold, italic, headings — is kept.", "बुनियादी फ़ॉर्मैटिंग — बोल्ड, इटैलिक, हेडिंग — रहती है।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("What is RTF?", "RTF क्या है?"),
     ("A 90s format many older programs (and legal offices) still use. This tool modernizes it into a PDF.", "90 के दशक का फ़ॉर्मैट जो कई पुराने प्रोग्राम (और कानूनी दफ़्तर) अब भी इस्तेमाल करते हैं। यह टूल इसे PDF में आधुनिक बना देता है।")], 5),
  "epub-to-pdf": ("pdf", "epub2pdf", ["view-pdf", "merge-pdf"],
    [("E-books (.epub) become printable PDFs.", "ई-बुक (.epub) प्रिंट करने लायक़ PDF बनती हैं।"),
     ("Chapters flow into continuous pages with reflowed text.", "अध्याय लगातार पेजों में बहते हैं, टेक्स्ट री-फ़्लो होता है।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Do images inside the book survive?", "किताब के अंदर की तस्वीरें बचती हैं?"),
     ("Yes, embedded images and covers render into the PDF. DRM-protected books will be honestly rejected.", "हाँ, एम्बेडेड तस्वीरें और कवर PDF में रेंडर होते हैं। DRM-वाली किताबें ईमानदारी से मना हो जाएँगी।")], 5),
  "publisher-to-pdf": ("pdf", "pub2pdf", ["view-pdf", "merge-pdf"],
    [("Microsoft Publisher (.pub) files get a real PDF conversion attempt.", "Microsoft Publisher (.pub) फ़ाइलों की सच्ची PDF रूपांतरण कोशिश होती है।"),
     ("Honest failure — .pub is a closed format; files the converter cannot parse are rejected with a clear message, never garbage.", "ईमानदार असफलता — .pub बंद फ़ॉर्मैट है; जो फ़ाइल कन्वर्टर नहीं पढ़ पाता उसे साफ़ संदेश के साथ मना किया जाता है, बेकार फ़ाइल कभी नहीं बनती।")],
    [("Why is .pub so hard?", ".pub इतना मुश्किल क्यों है?"),
     ("Microsoft never published the format, so converters reverse-engineer it — simple flyers usually work, complex catalogs may not. PDFs exported from Publisher itself always look best.", "Microsoft ने फ़ॉर्मैट कभी सार्वजनिक नहीं किया, इसलिए कन्वर्टर इसे रिवर्स-इंजीनियर करते हैं — सादे फ़्लायर अक्सर चल जाते हैं, जटिल कैटलॉग शायद नहीं। Publisher से सीधे निकाली PDF हमेशा सबसे अच्छी दिखती है।")], 3),
  "html-to-pdf": ("pdf", "html2pdf", ["view-pdf", "merge-pdf"],
    [("HTML files (or saved web pages) become exact PDFs — rendered by a real browser engine, so CSS layouts look right.", "HTML फ़ाइलें (या सेव किए वेबपेज) सटीक PDF बनती हैं — असली ब्राउज़र इंजन से रेंडर, इसलिए CSS लेआउट सही दिखते हैं।"),
     ("Landscape option for wide pages.", "चौड़े पेजों के लिए लैंडस्केप विकल्प।"),
     ("Server-assisted — Sidocs's own renderer, nothing else.", "सर्वर-सहायता — Sidocs का अपना रेंडरर, और कुछ नहीं।")],
    [("What about a whole website by URL?", "URL से पूरी वेबसाइट के बारे में?"),
     ("Use the Webpage to PDF tool for live URLs — this one converts HTML files you already have on your device.", "लाइव URL के लिए Webpage to PDF टूल इस्तेमाल करें — यह टूल आपकी डिवाइस पर मौजूद HTML फ़ाइलें बदलता है।")], 5),
  "pdf-to-word": ("docx", "pdf2word", ["view-pdf"],
    [("PDFs become editable .docx files — paragraphs, bold, headings and lists survive.", "PDF एडिट करने लायक़ .docx बनती है — पैराग्राफ़, बोल्ड, हेडिंग और लिस्ट बचते हैं।"),
     ("Great for rewriting old reports whose source file is lost.", "उन पुरानी रिपोर्ट को फिर लिखने के लिए बढ़िया जिनकी मूल फ़ाइल ग़ायब है।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Will it be pixel-perfect?", "क्या यह बिल्कुल वैसी ही होगी?"),
     ("No converter promises that — PDF is a print format. Text and structure come over well; exact fonts, multi-column layouts and tables may need touch-ups in Word.", "कोई कन्वर्टर यह वादा नहीं करता — PDF प्रिंट फ़ॉर्मैट है। टेक्स्ट और संरचना अच्छे आते हैं; सटीक फ़ॉन्ट, मल्टी-कॉलम लेआउट और टेबल Word में थोड़ी मरम्मत माँग सकते हैं।"),
     ("What about scanned PDFs?", "स्कैन की हुई PDF का क्या?"),
     ("A scanned PDF is images — this tool keeps them as images in the document. Run OCR first if you want text out of scans.", "स्कैन PDF तस्वीरें होती हैं — यह टूल उन्हें दस्तावेज़ में तस्वीर ही रखता है। स्कैन से टेक्स्ट चाहिए तो पहले OCR चलाएँ।")], 3),
  "pdf-to-excel": ("xlsx", "pdf2excel", ["view-pdf"],
    [("Table-like PDFs become .xlsx spreadsheets you can sort and total.", "टेबल जैसी PDF .xlsx स्प्रेडशीट बनती है जिसे सॉर्ट और जोड़ सकते हैं।"),
     ("Column alignment is detected from the PDF's text layout.", "कॉलम-सीध PDF के टेक्स्ट लेआउट से पहचाने जाते हैं।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Does it detect every table perfectly?", "क्या हर टेबल पूरी सही पहचानी जाती है?"),
     ("Clean, well-spaced tables convert well. Border-less or merged-cell tables may need column fixes afterwards.", "साफ़, ठीक से बँटी टेबल अच्छी बनती हैं। बिना-बॉर्डर या मर्ज्ड-सेल टेबलों में बाद में कॉलम ठीक करने पड़ सकते हैं।")], 3),
  "pdf-to-powerpoint": ("pptx", "pdf2ppt", ["view-pdf"],
    [("PDF pages become .pptx slides you can reorder and restyle.", "PDF पेज .pptx स्लाइड बनते हैं — रिअरेंज और रीस्टाइल कर सकते हैं।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Is the text editable on the slide?", "स्लाइड पर टेक्स्ट एडिट होता है?"),
     ("Yes — text arrives as editable text boxes. Complex graphics may come through as background images.", "हाँ — टेक्स्ट एडिट करने लायक़ टेक्स्ट-बॉक्स में आता है। जटिल ग्राफ़िक्स बैकग्राउंड इमेज की तरह आ सकते हैं।")], 3),
  "pdf-to-odt": ("odt", "pdf2odt", ["view-pdf"],
    [("PDFs become .odt documents for LibreOffice and Google Docs.", "PDF .odt दस्तावेज़ बनती है — LibreOffice और Google Docs के लिए।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Why .odt instead of .docx?", ".docx की जगह .odt क्यों?"),
     (".odt is the open standard — handy when you live in LibreOffice or Google Docs. For MS Word, use PDF to Word instead.", ".odt खुला स्टैंडर्ड है — LibreOffice या Google Docs में काम करने वालों के लिए। MS Word के लिए PDF to Word चुनें।")], 3),
  "pdf-to-svg": ("image", "pdf2svg", ["view-pdf"],
    [("Page 1 of your PDF becomes a true vector SVG — infinitely zoomable, editable in Illustrator/Inkscape.", "आपकी PDF का पेज 1 असली वेक्टर SVG बनता है — अनगिनत ज़ूम, Illustrator/Inkscape में एडिट।"),
     ("Text stays text, shapes stay shapes — no rasterizing.", "टेक्स्ट टेक्स्ट रहता है, आकृति आकृति — कोई रास्टराइज़ नहीं।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("Why only page 1?", "सिर्फ़ पेज 1 क्यों?"),
     ("SVG is a single-image format. Use Split PDF first to pull the exact page you want, then convert it here.", "SVG एक-इमेज फ़ॉर्मैट है। पहले Split PDF से ज़रूरी पेज निकालें, फिर यहाँ बदलें।")], 3),
  "pdf-to-pdfa": ("pdf", "pdf2pdfa", ["view-pdf"],
    [("Any PDF becomes an archival PDF/A-1b, 2b or 3b — the format governments and courts ask for.", "कोई भी PDF अभिलेखीय PDF/A-1b, 2b या 3b बनती है — वह फ़ॉर्मैट जो सरकारें और अदालतें माँगती हैं।"),
     ("Colours are normalized and fonts embedded so the file looks the same in 25 years.", "रंग नॉर्मलाइज़् और फ़ॉन्ट एम्बेड होते हैं ताकि फ़ाइल 25 साल बाद भी वैसी ही दिखे।"),
     ("Server-assisted — Sidocs's own converter, nothing else.", "सर्वर-सहायता — Sidocs का अपना कन्वर्टर, और कुछ नहीं।")],
    [("What is PDF/A?", "PDF/A क्या है?"),
     ("A PDF standard built for long-term storage — no external dependencies, no JavaScript, fonts always embedded. Archives in India, the EU and elsewhere require it.", "लंबे समय के भंडारण के लिए बना PDF स्टैंडर्ड — कोई बाहरी निर्भरता नहीं, फ़ॉन्ट हमेशा एम्बेड। भारत, यूरोप वगैरह के अभिलेखागार इसे माँगते हैं।"),
     ("Which level should I pick?", "कौन-सा लेवल चुनूँ?"),
     ("2b is the safe default. Pick 1b only when an old system demands the original 2005 spec, 3b when embeddings of newer formats are allowed.", "2b सुरक्षित डिफ़ॉल्ट है। 1b सिर्फ़ तब जब कोई पुराना सिस्टम 2005 का मूल स्पेक माँगे, 3b जब नए फ़ॉर्मैट के एम्बेड की इजाज़त हो।")], 3),
}

HOW = {
  "word2pdf": ("Drop one or more Word files (.doc, .docx).", "एक या कई Word फ़ाइलें छोड़ें (.doc, .docx)।", "Run the conversion — each file becomes its own PDF.", "रूपांतरण चलाएँ — हर फ़ाइल की अपनी PDF बनती है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "excel2pdf": ("Drop spreadsheets (.xls, .xlsx, .ods, .csv).", "स्प्रेडशीट छोड़ें (.xls, .xlsx, .ods, .csv)।", "Run the conversion — each workbook becomes a printable PDF.", "रूपांतरण चलाएँ — हर वर्कबुक प्रिंट करने लायक़ PDF बनती है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "ppt2pdf": ("Drop presentations (.ppt, .pptx, .odp).", "प्रेज़ेंटेशन छोड़ें (.ppt, .pptx, .odp)।", "Run the conversion — one PDF page per slide.", "रूपांतरण चलाएँ — हर स्लाइड की एक PDF पेज।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "odt2pdf": ("Drop OpenDocument files (.odt).", "OpenDocument फ़ाइलें छोड़ें (.odt)।", "Run the conversion — the document becomes a share-ready PDF.", "रूपांतरण चलाएँ — दस्तावेज़ शेयर करने लायक़ PDF बनता है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "rtf2pdf": ("Drop Rich Text files (.rtf).", "Rich Text फ़ाइलें छोड़ें (.rtf)।", "Run the conversion — the old file becomes a clean PDF.", "रूपांतरण चलाएँ — पुरानी फ़ाइल साफ़ PDF बनती है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "epub2pdf": ("Drop e-books (.epub).", "ई-बुक छोड़ें (.epub)।", "Run the conversion — the book flows into a printable PDF.", "रूपांतरण चलाएँ — किताब प्रिंट करने लायक़ PDF में बहती है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "pub2pdf": ("Drop Publisher files (.pub).", "Publisher फ़ाइलें छोड़ें (.pub)।", "Run the attempt — most simple flyers convert; anything the converter cannot parse is honestly rejected, never garbage.", "कोशिश चलाएँ — ज़्यादातर सादे फ़्लायर बदल जाते हैं; जो पार्स न हो सके उसे ईमानदारी से मना किया जाता है, बेकार फ़ाइल कभी नहीं।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "html2pdf": ("Drop an HTML file you saved (or exported from a tool).", "अपनी सेव की हुई HTML फ़ाइल छोड़ें (या किसी टूल से निकाली हुई)।", "Run the conversion — a real browser engine renders your page.", "रूपांतरण चलाएँ — असली ब्राउज़र इंजन आपका पेज रेंडर करता है।", "Preview, then download or continue with the other PDF tools.", "प्रीव्यू देखें, फिर डाउनलोड करें या दूसरे PDF टूल्स के साथ आगे बढ़ें।"),
  "pdf2word": ("Drop the PDF you want to edit again.", "जिस PDF को फिर एडिट करना है उसे छोड़ें।", "Run the conversion — text, headings and lists become a real Word document.", "रूपांतरण चलाएँ — टेक्स्ट, हेडिंग और लिस्ट असली Word दस्तावेज़ बनते हैं।", "Fix any layout quirks in Word — PDF is a print format, so this is a best-effort edit, not a mirror.", "Word में लेआउट की दिक्कतें ठीक कर लें — PDF प्रिंट फ़ॉर्मैट है, इसलिए यह बेहतरीन-कोशिश है, आईना नहीं।"),
  "pdf2excel": ("Drop the PDF with tables.", "टेबल वाली PDF छोड़ें।", "Run the conversion — table lines become spreadsheet rows.", "रूपांतरण चलाएँ — टेबल की लाइनें स्प्रेडशीट पंक्तियाँ बनती हैं।", "Check the columns in Excel/Sheets and fix any merges.", "Excel/Sheets में कॉलम जाँचें और मर्ज ठीक करें।"),
  "pdf2ppt": ("Drop the PDF you want as slides.", "स्लाइड रूप में चाही PDF छोड़ें।", "Run the conversion — pages become editable slides.", "रूपांतरण चलाएँ — पेज एडिट करने लायक़ स्लाइड बनते हैं।", "Restyle in PowerPoint; text boxes are real text.", "PowerPoint में रीस्टाइल करें; टेक्स्ट-बॉक्स असली टेक्स्ट हैं।"),
  "pdf2odt": ("Drop the PDF you want in LibreOffice.", "LibreOffice में चाही PDF छोड़ें।", "Run the conversion — the PDF becomes an .odt document.", "रूपांतरण चलाएँ — PDF .odt दस्तावेज़ बनती है।", "Continue editing in LibreOffice or Google Docs.", "LibreOffice या Google Docs में एडिटिंग जारी रखें।"),
  "pdf2svg": ("Drop the PDF — page 1 is converted (split first if you need another page).", "PDF छोड़ें — पेज 1 बदलता है (दूसरा पेज चाहिए तो पहले स्प्लिट करें)।", "Run the conversion — the page becomes a true vector SVG.", "रूपांतरण चलाएँ — पेज असली वेक्टर SVG बनता है।", "Open in Illustrator/Inkscape — text stays text, shapes stay shapes.", "Illustrator/Inkscape में खोलें — टेक्स्ट टेक्स्ट रहता है, आकृति आकृति।"),
  "pdf2pdfa": ("Drop any PDF.", "कोई भी PDF छोड़ें।", "Pick the PDF/A level and run — 2b is the safe default.", "PDF/A लेवल चुनकर चलाएँ — 2b सुरक्षित डिफ़ॉल्ट है।", "Download the archival copy — validate it in the Validate PDF/A tool.", "अभिलेखीय कॉपी डाउनलोड करें — Validate PDF/A टूल से जाँच भी लें।"),
}

TEMPLATE = '''import type {{ ToolConfig }} from "@/lib/tools/config-types";

/**
 * {tid} (P9 server-convert family) — Mode S tool backed by the
 * LibreOffice/Ghostscript/poppler convert service. This config is pure
 * wiring: the shared proxy worker (tools/server-convert/worker.ts)
 * maps the toolId to the service action. Honest scope + privacy notes
 * live in the FAQ below.
 */
export const config: ToolConfig = {{
  toolId: "{tid}",
  createWorker: () =>
    new Worker(new URL("../server-convert/worker.ts", import.meta.url), {{
      type: "module",
    }}),
  outputKind: "{outKind}",
  minFiles: 1,
  maxFiles: {maxf},
  howKeys: ["{ns}.how1", "{ns}.how2", "{ns}.how3"],
  chainToolIds: {chain},
  options: [{opts}
  ],
  features: [{feats}
  ],
  faq: [{faqs}
  ],
}};
'''

OPT_LANDSCAPE = '''
    {
      kind: "switch",
      id: "landscape",
      label: {
        en: "Landscape pages",
        hi: "लैंडस्केप पेज",
      },
    }'''

OPT_PDFA = '''
    {
      kind: "select",
      id: "pdfaLevel",
      label: {
        en: "PDF/A level",
        hi: "PDF/A लेवल",
      },
      hint: {
        en: "2b is the safe default",
        hi: "2b सुरक्षित डिफ़ॉल्ट है",
      },
      choices: [
        { value: "1", label: { en: "PDF/A-1b (2005)", hi: "PDF/A-1b (2005)" } },
        { value: "2", label: { en: "PDF/A-2b (2011)", hi: "PDF/A-2b (2011)" } },
        { value: "3", label: { en: "PDF/A-3b (2012)", hi: "PDF/A-3b (2012)" } },
      ],
      default: "2",
    }'''


def main():
    for tid, (out_kind, ns, chain, features, faq, maxf) in TOOLS.items():
        if tid == "html-to-pdf":
            options = OPT_LANDSCAPE
        elif tid == "pdf-to-pdfa":
            options = OPT_PDFA
        else:
            options = ""
        feats = ""
        for en_t, hi_t in features:
            feats += "\n    {\n      en: %s,\n      hi: %s,\n    }," % (
                json.dumps(en_t, ensure_ascii=False), json.dumps(hi_t, ensure_ascii=False))
        faqs = ""
        for i in range(0, len(faq), 2):
            (q_en, q_hi), (a_en, a_hi) = faq[i], faq[i + 1]
            faqs += "\n    {\n      q: {\n        en: %s,\n        hi: %s,\n      },\n      a: {\n        en: %s,\n        hi: %s,\n      },\n    }," % tuple(
                json.dumps(x, ensure_ascii=False) for x in (q_en, q_hi, a_en, a_hi))
        cfg = TEMPLATE.format(tid=tid, outKind=out_kind, ns=ns,
                               chain=json.dumps(chain), maxf=maxf,
                               opts=options, feats=feats, faqs=faqs)
        os.makedirs(f"tools/{tid}", exist_ok=True)
        with open(f"tools/{tid}/config.ts", "w") as f:
            f.write(cfg)
        print("wrote", tid)

    with open("src/i18n/en.json") as f:
        en = json.load(f)
    with open("src/i18n/hi.json") as f:
        hi = json.load(f)
    for ns, (h1en, h1hi, h2en, h2hi, h3en, h3hi) in HOW.items():
        en[ns] = {"how1": h1en, "how2": h2en, "how3": h3en}
        hi[ns] = {"how1": h1hi, "how2": h2hi, "how3": h3hi}
    with open("src/i18n/en.json", "w") as f:
        json.dump(en, f, indent=2, ensure_ascii=False)
    with open("src/i18n/hi.json", "w") as f:
        json.dump(hi, f, indent=2, ensure_ascii=False)

    def flat(d):
        n = 0
        for v in d.values():
            n += flat(v) if isinstance(v, dict) else 1
        return n
    print("i18n parity:", flat(en), "=", flat(hi))


if __name__ == "__main__":
    main()
