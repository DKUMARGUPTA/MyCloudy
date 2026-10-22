/**
 * Builds public/qa/sample-book.epub — the browser-QA fixture for the
 * epub-to-pdf tool. Same OCF shape the smoke builder uses: mimetype
 * FIRST + STORED, container.xml → OPF, spine with 2 EN chapters +
 * 1 Hindi chapter, NCX nav.
 * Run: bun scripts/make-epub-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { zipSync, strToU8, type Zippable } from "fflate";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Sample Book</dc:title>
    <dc:creator>MyCloudy QA</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:mycloudy-qa-1</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:mycloudy-qa-1"/></head>
  <docTitle><text>Sample Book</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>First Steps</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Going Further</text></navLabel><content src="ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>हिंदी अध्याय</text></navLabel><content src="ch3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>First Steps</title></head>
<body>
<h1>First Steps</h1>
<p>This is a <b>sample</b> <i>chapter</i> for browser QA of the EPUB to PDF tool on MyCloudy.</p>
<p>It has ordinary paragraphs, a little styling, and a list:</p>
<ul><li>First item</li><li>Second item</li><li>Third item</li></ul>
</body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Going Further</title></head>
<body>
<h1>Going Further</h1>
<h2>A section</h2>
<p>The second chapter makes the book long enough to prove multi-page pagination works end to end in the browser.</p>
<p>The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.</p>
<p>The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.</p>
</body>
</html>`;

const CH3 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>हिंदी अध्याय</title></head>
<body>
<h1>हिंदी अध्याय</h1>
<p>यह हिंदी पाठ है। देवनागरी लिपि में लिखा गया अध्याय यह जाँचता है कि फ़ॉन्ट सही ढंग से जुड़ता है।</p>
<p>मायक्लाउडी ब्राउज़र में ही काम करता है — कोई फ़ाइल सर्वर पर नहीं जाती।</p>
</body>
</html>`;

const entries: Zippable = {
  mimetype: [strToU8("application/epub+zip"), { level: 0 }],
  "META-INF/container.xml": [strToU8(CONTAINER), { level: 6 }],
  "OEBPS/content.opf": [strToU8(OPF), { level: 6 }],
  "OEBPS/toc.ncx": [strToU8(NCX), { level: 6 }],
  "OEBPS/ch1.xhtml": [strToU8(CH1), { level: 6 }],
  "OEBPS/ch2.xhtml": [strToU8(CH2), { level: 6 }],
  "OEBPS/ch3.xhtml": [strToU8(CH3), { level: 6 }],
};

const bytes = zipSync(entries);
writeFileSync("public/qa/sample-book.epub", bytes);
console.log(`public/qa/sample-book.epub written (${bytes.length} bytes)`);
