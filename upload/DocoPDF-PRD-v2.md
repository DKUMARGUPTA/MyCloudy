**DocoPDF.com**

Product Requirements Document (PRD)

*Har PDF kaam, ek jagah. Fast, free, private.*

| **Field** | **Detail**                                                                                                                    |
|-----------|-------------------------------------------------------------------------------------------------------------------------------|
| Version   | v2.0 (detailed, all tools)                                                                                                    |
| Date      | 5 October 2026                                                                                                                |
| Product   | Online PDF tools website, English + Hindi                                                                                     |
| Stack     | GitHub (code), Vercel (hosting), Turso (database), files sirf user ke device par                                              |
| Status    | Draft for build planning                                                                                                      |
| Note      | Is document me license, legal aur pricing ke points planning ke liye hain. Launch se pehle lawyer se review zaroor karwayein. |

**Contents**

1\. Vision, Goals aur Principles

1.1 Vision

DocoPDF ek aisi website hai jahan user ko har PDF kaam (merge, split, compress, edit, sign, convert, OCR, secure) ek hi jagah, bina signup, tez aur private tareeke se mile. PDF24 jaise tools ki range, iLovePDF jaisa simple flow, aur PDFSimpli se behtar editor.

1.2 Competitor gap

| **Competitor** | **Kya achha**              | **Kya weak (hamara mauka)**                                                                |
|----------------|----------------------------|--------------------------------------------------------------------------------------------|
| PDF24 Tools    | 100+ free tools, no signup | UI purani aur crowded, tool pages me bahut text, editor basic, files server par jaati hain |
| iLovePDF       | Clean 3-step flow, fast    | Editing weak, free limits, upload zaroori, signup nudges                                   |
| PDFSimpli      | Editor aur templates       | Paywall aur subscription complaints, aggressive upsell, kam free tools                     |

1.3 Goals (measurable)

- **Privacy:** zyada-tar tools browser me chalein, file kabhi server par na jaaye (Device-only badge).

- **Speed:** upload se download tak 30 second se kam (typical 5 MB file).

- **Simplicity:** har tool 3 click me complete (Select, Option, Download).

- **Editor:** Edit PDF Word jaisa easy ho, mobile par bhi chale.

- **Coverage:** PDF24 ke saare tool categories + India-specific tools (GST invoice, Aadhaar/PAN redact, Hindi OCR).

- **Growth:** SEO se organic traffic, har tool ka apna optimized page.

1.4 Product principles

- Privacy-first aur honest: jo tool server par chalta hai usse clearly "Server processing" badge dein, jhooth na bolen.

- No dark patterns: forced signup nahi, hidden subscription nahi, cancel ek click me.

- Mobile-first: India me zyada traffic mobile se hai. Touch targets 44px+, low-end Android par chale.

- Bilingual from day one: English aur Hindi (Devanagari), baad me aur languages.

- Self-hosted assets: fonts, icons, pdf.js, WASM, OCR language data sab apne domain se. Koi third-party CDN nahi.

1.5 Target users

| **Persona**                      | **Kaam**                                    | **Zaruratein**                            |
|----------------------------------|---------------------------------------------|-------------------------------------------|
| Student                          | Notes merge, assignment compress, form fill | Free, mobile, fast                        |
| Job seeker / Office worker       | Resume, documents sign, Word-PDF            | Edit, sign, convert                       |
| Small business / CA / Shop owner | GST invoice, scan, merge, protect           | Invoice tools, batch, Hindi               |
| Government form bharne wale      | Aadhaar/PAN size compress, photo-to-PDF     | 100KB/200KB target compress, image to PDF |
| Power user / Freelancer          | Edit, compare, redact, OCR                  | Pro editor, large files, batch            |

2\. Architecture aur Technical Decisions

2.1 Chune gaye platforms

| **Layer**    | **Tool**                             | **Kaam**                                                  | **Dhyan dene wali baat**                                                                                                 |
|--------------|--------------------------------------|-----------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| Code         | GitHub                               | Repo, PR, GitHub Actions CI                               | Monorepo; main = production                                                                                              |
| Hosting      | Vercel                               | Next.js pages, SSG/SSR, light API, CDN, preview deploys   | Hobby plan non-commercial hai, ads/Pro ke liye Vercel Pro chahiye. Request body ~4.5MB limit; heavy binaries nahi chalte |
| Database     | Turso (libSQL)                       | Users, usage, feedback, blog, payments metadata           | Sirf metadata. PDF ka content ya filename kabhi nahi                                                                     |
| File storage | User ka device                       | OPFS, IndexedDB, download/share                           | Server par file storage nahi                                                                                             |
| Heavy worker | Apna Docker server (VPS/Fly/Railway) | Office conversion, strong OCR/compress, PDF/A, validation | Stateless: memory/temp me process, turant delete. Phase 3                                                                |

2.2 Do processing modes

| **Mode**            | **Badge (UI)**                          | **Kya hota hai**                                                                         | **Privacy claim**                                                 |
|---------------------|-----------------------------------------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| D = Device-only     | Private - stays on your device          | Pura kaam browser me Web Worker me. File network par jaati hi nahi                       | "Your files never leave your device"                              |
| S = Server-assisted | Server processing - deleted right after | File worker server par jaati hai, process hoti hai, result milta hai, file turant delete | "Deleted immediately after processing" (max 15 min fail-safe TTL) |

**Rule:** Device-only tool par kabhi server call nahi honi chahiye. CI me ek test hoga jo in tools ke network requests check kare (file upload endpoint hit na ho).

2.3 Libraries (sab self-hosted)

| **Kaam**                                         | **Library**                                       | **License**      | **Note**                                                                       |
|--------------------------------------------------|---------------------------------------------------|------------------|--------------------------------------------------------------------------------|
| PDF render, preview, text layer                  | pdf.js (Mozilla)                                  | Apache 2.0       | Worker file bhi self-host. Thumbnails ke liye low-res render                   |
| PDF modify (merge, split, draw, forms, metadata) | pdf-lib                                           | MIT              | Encryption support NAHI. Isliye Protect/Unlock ke liye qpdf-wasm               |
| Encrypt/decrypt, repair, linearize               | qpdf (WASM build)                                 | Apache 2.0       | Browser me AES-256, repair, web-optimize                                       |
| Editor canvas / objects                          | Fabric.js ya Konva                                | MIT              | Object select, resize, rotate, undo                                            |
| OCR (browser)                                    | Tesseract.js + traineddata                        | Apache 2.0       | eng, hin aur other languages self-host; model files badi hoti hain (lazy-load) |
| Office to PDF, PDF to Office (server)            | LibreOffice headless                              | MPL 2.0          | Worker server par. PDF to Word quality limited, expectation set karein         |
| Server compress/optimize                         | qpdf + pdfcpu                                     | Apache 2.0       | Ghostscript/MuPDF AGPL hain, avoid ya commercial license                       |
| PDF/A validate (server)                          | veraPDF                                           | GPL/MPL dual     | Java service; license lawyer se check karein                                   |
| Zip output                                       | fflate                                            | MIT              | Multiple output files ke liye                                                  |
| Image decode                                     | Browser APIs; UTIF.js (TIFF); heic decoder (WASM) | MIT / LGPL check | HEIC library license verify karein                                             |
| Markdown, QR, charts                             | marked, qrcode generator                          | MIT              |                                                                                |
| Digital signature verify/sign                    | pkijs / node-forge                                | BSD              | PAdES basic, Phase 3                                                           |

**License warning:** AGPL libraries (Ghostscript, MuPDF) use karne par aapko apna source open karna pad sakta hai ya commercial license lena padega. Default stack me inhe shamil nahi kiya gaya hai.

2.4 Device par storage

| **Kaam**                                           | **Technology**                                                      | **Rule**                                                     |
|----------------------------------------------------|---------------------------------------------------------------------|--------------------------------------------------------------|
| Badi file ka working copy                          | OPFS                                                                | Tool ke baad ya "Clear" par delete                           |
| Recent files (metadata + thumbnail), editor drafts | IndexedDB                                                           | Max 20 recent, 30 din; user "Clear all" kar sake             |
| Saved signatures, settings, favorites              | IndexedDB / localStorage                                            | Sirf device par, account me sync Phase 3 (opt-in, encrypted) |
| Result save                                        | File System Access API; fallback download; mobile par Web Share API | iOS Safari me download/Share sheet ka fallback               |
| Offline                                            | PWA + Service Worker                                                | Device-only tools offline chalein                            |

- iPhone Safari kuch din na kholne par storage saaf kar sakta hai. PWA install prompt dein aur result hamesha download/share karwayein.

- Upload se pehle navigator.storage.estimate() check karein; space kam ho to warning.

- Low-end phone par RAM limit: Web Worker, page-by-page processing, file size limit (device-wise: 50MB mobile, 200MB desktop default, adjustable).

- Editor draft sirf us browser me hai, ye note editor me dikhayein.

2.5 Turso database schema

| **Table**        | **Columns**                                                                   | **Use**                                                           |
|------------------|-------------------------------------------------------------------------------|-------------------------------------------------------------------|
| users            | id, email, name, password_hash/oauth_id, plan, locale, created_at, deleted_at | Login (Phase 2/3)                                                 |
| sessions         | id, user_id, expires_at, ua_hash                                              | Auth sessions                                                     |
| anon_usage       | id (signed cookie id), tool_id, day, count                                    | Daily limit server-assisted tools par                             |
| usage_events     | id, tool_id, mode, success, duration_ms, size_bucket, locale, day             | Aggregate analytics, koi filename/content nahi                    |
| feedback         | id, tool_id, rating, message, email_optional, created_at                      | Result page feedback                                              |
| tool_requests    | id, title, description, votes, status                                         | Request a tool + roadmap vote                                     |
| request_votes    | request_id, voter_hash                                                        | Duplicate vote rokna                                              |
| contact_messages | id, name, email, category, message, status, created_at                        | Contact form                                                      |
| blog_posts       | slug, locale, title, excerpt, body_md, tags, published_at, updated_at         | Blog / guides                                                     |
| subscriptions    | id, user_id, provider, provider_sub_id, plan, status, period_end              | Razorpay/Stripe                                                   |
| payments         | id, user_id, provider_payment_id, amount, currency, status, invoice_no        | Billing history                                                   |
| jobs             | id, tool_id, status, created_at, finished_at, error_code                      | Server tools status (file keys nahi, kyunki file store nahi hoti) |
| audit_log        | id, actor, action, meta_json, created_at                                      | Admin actions                                                     |

- Turso me dev aur prod alag database. Token sirf Vercel environment variables me.

- Drizzle ORM + migrations GitHub me.

- Personal data minimum: email aur payment metadata. DPDP Act 2023 ke hisaab se retention aur deletion flow.

2.6 Repo structure

Monorepo layout

docopdf/

apps/web/ Next.js + TypeScript + Tailwind (Vercel)

app/\[locale\]/ pages: home, tools, tool pages, blog, legal

components/ DropZone, PageGrid, Viewer, Editor, ResultCard, ToolShell

tools/\<tool-id\>/ config.ts (meta, options schema), worker.ts, Panel.tsx

lib/pdf/ pdf-lib + pdf.js + qpdf wrappers, worker pool

lib/storage/ OPFS, IndexedDB helpers

public/pdfjs/ wasm/ tessdata/ fonts/ self-hosted assets

db/ Drizzle schema + Turso client

services/worker/ Docker: LibreOffice, qpdf, pdfcpu, Tesseract (Phase 3)

.github/workflows/ lint, typecheck, unit, e2e (Playwright), license-check

docs/ PRD, tool specs, runbooks

**Tool config pattern:** har tool ek config object se define ho (id, slug, category, mode, accepted types, options schema, worker entry, SEO copy keys). Isse 100+ tool pages ek hi template se bante hain aur naya tool jodna aasan hota hai.

2.7 Server worker flow (S-mode tools)

- Browser Vercel API se short-lived signed token leta hai (daily limit check hota hai).

- Browser file seedha worker domain (jaise api.docopdf.com) ko bhejta hai. Vercel ki 4.5MB limit bypass hoti hai.

- Worker job queue me process karta hai, result stream karta hai, aur temp files turant delete karta hai. Fail-safe cleanup har 5 minute me, max TTL 15 minute.

- Worker par ClamAV scan, rate limit, size limit, aur sandbox (no network, resource limits).

- Worker kuch log nahi karta jo file ka content ya naam ho. Sirf job id, tool, size bucket, duration, error code.

2.8 Performance targets

| **Metric**                                | **Target**                                          |
|-------------------------------------------|-----------------------------------------------------|
| Home LCP (4G mobile)                      | \< 2.0 s (desktop \< 1.2 s)                         |
| Initial JS (home)                         | \< 150 KB gzip                                      |
| Tool page initial JS (before file select) | \< 120 KB; pdf.js/pdf-lib lazy-load on file select  |
| Thumbnail render                          | \< 100 ms per page, virtualized list for 100+ pages |
| Merge 10 files x 5MB (mid-range phone)    | \< 10 s                                             |
| CLS / INP                                 | \< 0.1 / \< 200 ms                                  |

3\. Design System

3.1 Colors

| **Token**    | **Light**           | **Dark**            | **Use**                               |
|--------------|---------------------|---------------------|---------------------------------------|
| primary      | \#2563EB            | \#60A5FA            | Links, active states, primary buttons |
| accent / CTA | \#F97316            | \#FB923C            | Main action button (Download, Merge)  |
| success      | \#16A34A            | \#4ADE80            | Done states, Private badge            |
| danger       | \#DC2626            | \#F87171            | Errors, destructive                   |
| bg / surface | \#FFFFFF / \#F8FAFC | \#0B1220 / \#111827 | Backgrounds                           |
| text / muted | \#0F172A / \#64748B | \#E5E7EB / \#94A3B8 | Text                                  |

Category colors: Organize = Blue, Edit = Purple, Convert = Green, Security = Red, Optimize = Orange, Create = Teal, Invoices = Amber, View = Slate. Dark mode day-one (system default + manual toggle).

3.2 Typography aur spacing

- Fonts: Inter (English), Noto Sans Devanagari (Hindi), JetBrains Mono (code/shortcuts). Sab self-hosted, font-display: swap.

- Scale: H1 36/40, H2 28/34, H3 20/28, body 16/24, small 14/20. Mobile H1 28.

- Spacing 4/8 grid. Radius: cards 16px, buttons 12px, chips 999px. Soft shadows, borders 1px.

- Icons: ek consistent line icon set (self-hosted SVG sprite), 24px grid. Tool icons custom, category color ke saath.

3.3 Core components

| **Component**        | **Spec**                                                                                                                                                            |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Tool Card            | Icon (48px), naam, 1-line description, mode badge (Private / Server), favorite star, hover lift, focus ring                                                         |
| Drop Zone            | Dashed border, drag-over highlight, "Select files" primary button, paste support (Ctrl+V), camera/scan option on mobile, accepted types aur size hint, error inline |
| File Card            | Thumbnail, name (editable), pages, size, status (ready/locked/error), actions (rotate, remove, unlock)                                                              |
| Page Thumbnail       | Page number, selection checkbox, rotate/delete on hover (always visible on touch), drag handle                                                                      |
| Options Panel        | Right side desktop, bottom sheet mobile; grouped fields, live summary                                                                                               |
| Sticky Action Bar    | Primary CTA full-width on mobile, shows what will happen ("Merge 3 files, 24 pages")                                                                                |
| Progress             | Determinate % with stage text, Cancel button, estimated time                                                                                                        |
| Toast / Banner       | Success, info, warning, error; auto-dismiss except error                                                                                                            |
| Modal / Sheet        | Focus trap, ESC close, mobile bottom sheet                                                                                                                          |
| Stepper              | Upload \> Options \> Download (read-only indicator)                                                                                                                 |
| Badges               | Private, Server, New, Pro, Beta                                                                                                                                     |
| Empty / Error states | Illustration + 1 line + action button                                                                                                                               |

3.4 Interaction rules

- Touch target minimum 44x44px; drag-reorder ke saath up/down buttons (accessibility).

- Motion subtle (150-250ms); prefers-reduced-motion respect.

- WCAG 2.2 AA contrast, visible focus, keyboard-operable har tool.

- Har destructive action par Undo toast (confirm modal ke bajay) jahan possible.

4\. Sitemap aur URL Structure

| **Section**       | **URLs**                                                                                                                                            |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| Core              | / /tools /search /install-app                                                                                                                       |
| Tool pages (EN)   | /merge-pdf /split-pdf /compress-pdf /edit-pdf /sign-pdf /word-to-pdf /pdf-to-word ... (har tool ka apna slug, Section 7 ki table dekhein)           |
| Hindi             | /hi/ prefix. Example: /hi/pdf-jodein (merge), /hi/pdf-compress-karein. hreflang en/hi                                                               |
| Categories        | /tools/organize /tools/edit /tools/convert-to-pdf /tools/convert-from-pdf /tools/security /tools/optimize /tools/create /tools/invoices /tools/view |
| Company           | /about /contact /security /press /careers (optional)                                                                                                |
| Help              | /help /help/\[article\] /faq /request-a-tool /roadmap /changelog /status                                                                            |
| Content           | /blog /blog/\[slug\] /guides/\[slug\]                                                                                                               |
| Pricing & account | /pricing /login /signup /account /account/billing /account/signatures /account/delete                                                               |
| Legal             | /privacy-policy /terms /cookie-policy /refund-policy /dmca /report-abuse /grievance /accessibility                                                  |
| System            | /404 /500 /offline /maintenance /sitemap.xml /robots.txt /manifest.webmanifest                                                                      |

5\. Global Elements

5.1 Header (sticky)

Desktop header

\[Logo DocoPDF\] \[All Tools v\] Merge Split Compress Edit Sign \[Search Ctrl+K\] \[Moon\] \[EN\|हिं\] \[Login\] \[Get Pro\]

- **Mega-menu:** 5-6 columns (Organize, Edit, Convert to PDF, Convert from PDF, Security, Create & more). Har tool icon + naam; bottom me "See all tools". Keyboard navigable.

- **Search (Ctrl+K / "/"):** tool naam, tags (jpg, word, resume, gst), Hindi keywords; typo-tolerant (client-side index, tool-search.json). Recent aur popular suggestions.

- **Mobile:** hamburger menu (full-screen sheet) + bottom tab bar: Home, Tools, Recent, Account. Language switch aur dark mode menu me.

- Header ke upar thin banner sirf announcements ke liye (dismissible).

5.2 Footer

- 4 columns: Popular tools \| Categories \| Company (About, Contact, Blog, Careers) \| Legal (Privacy, Terms, Cookies, Refund, DMCA, Grievance).

- Language switcher, social links, install app link, status link.

- Trust line: "Most tools run inside your browser. Your files stay on your device."

- Copyright aur company/registered details (legal ke liye).

5.3 Cookie / consent banner

Minimal bottom banner: Accept all / Reject non-essential / Customize. Default: analytics OFF. Consent choice storage me save, footer me "Privacy settings" link se badal sakte hain. DPDP/GDPR friendly copy.

5.4 Global behaviors

- Language: URL prefix se; user ka choice remember.

- Theme: system / light / dark.

- Offline indicator: "You are offline. Device-only tools still work."

- Update toast jab naya service worker available.

- Error boundary: tool crash par friendly message + "Report this problem" (koi file content nahi bheji jaati).

- Feedback widget (floating, minimal) har page par.

6\. Core Page Specifications

6.1 Home Page

Home wireframe (desktop)

+--------------------------------------------------------------------------+

\| Header \|

+--------------------------------------------------------------------------+

\| H1: Sab PDF tools, ek jagah. Free, fast aur private. \|

\| Sub: Zyada-tar tools aapke browser me chalte hain - file upload nahi. \|

\| +--------------------------------------------------------------+ \|

\| \| \[ Drop PDF here / Select files \] (Paste, Camera) \| \|

\| \| After drop: "Aap kya karna chahte hain?" \| \|

\| \| \[Edit\] \[Compress\] \[Merge\] \[Convert\] \[Sign\] \[Protect\] \| \|

\| +--------------------------------------------------------------+ \|

\| Badges: \[Private\] \[No signup\] \[Free\] \[Works offline\] \|

+--------------------------------------------------------------------------+

\| Quick tools (8 cards): Merge Split Compress Edit Sign Word\>PDF PDF\>JPG.. \|

+--------------------------------------------------------------------------+

\| Category tabs: All \| Organize \| Edit \| Convert \| Security \| Create \| ... \|

\| Tool grid (cards) \|

+--------------------------------------------------------------------------+

\| Why DocoPDF: \[Private\] \[Fast\] \[No signup\] \|

\| Pro editor showcase (demo video / interactive) \|

\| How it works: 1 Select 2 Choose 3 Download \|

\| India special: GST invoice, 100KB compress, Aadhaar redact, Hindi OCR \|

\| Recent files / Favorites (this device only) \|

\| Testimonials / numbers (real only) \|

\| FAQ (schema) + Final CTA \|

+--------------------------------------------------------------------------+

| **Section**            | **Requirement**                                                                                                                                                                                                                        |
|------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Hero + Smart Drop Zone | File drop karte hi file type detect karke relevant tools suggest (PDF: edit/compress/merge/split/sign; image: Images to PDF; Word: Word to PDF). File OPFS me rakhi jaati hai aur selected tool ko pass hoti hai (dobara upload nahi). |
| Quick tools            | 8 sabse popular tools, usage data se auto-order (default curated)                                                                                                                                                                      |
| Category tabs          | Tab change instant (client), URL hash update; keyboard arrow navigation                                                                                                                                                                |
| Why DocoPDF            | 3 cards: Private (device-only), Fast (no upload wait), No signup/watermark                                                                                                                                                             |
| India special strip    | GST Invoice, Compress to 100KB/200KB, Photo+Signature size tool, Aadhaar/PAN redact, Hindi OCR                                                                                                                                         |
| Recent files           | Sirf local metadata + thumbnails; "Clear" button; empty state hidden                                                                                                                                                                   |
| FAQ                    | 8-10 questions with FAQPage schema                                                                                                                                                                                                     |
| Performance            | Hero server-rendered; tool grid SSG; images lazy; no layout shift                                                                                                                                                                      |

6.2 All Tools Page

- Top: large search box (autofocus on desktop) + sticky category chips (Favorites, Last used, Frequently used, Organize, Edit, Convert, Security, Optimize, Create, Invoices, View).

- Views toggle: Grid (default) / List. Sort: Popular / A-Z.

- Tool card: icon, naam, 1 line, favorite star, badge Private/Server/New/Pro.

- Favorites aur Last used localStorage se (device-only), pehli visit par hidden.

- Filters (desktop sidebar): Mode (Private / Server), Input type (PDF, Word, Image...), Free vs Pro.

- Search no result: "Tool nahi mila" + \[Request a tool\] button + popular tools.

- Page par SEO text minimal; category pages (/tools/organize) par detailed intro.

6.3 Universal Tool Page (4 states)

Sab tools ek template (ToolShell) use karte hain. Har tool ka config UI aur options inject karta hai.

State 1 - Landing / Upload

Breadcrumb: Home \> Organize \> Merge PDF

+--------------------------------------------------------------+

\| H1: Merge PDF \|

\| Ek line description. \[Private - stays on your device\] \|

\| +--------------------------------------------------------+ \|

\| \| \[ Select PDF files \] or drop here \| \|

\| \| Paste (Ctrl+V) \| Camera \| (Drive/Dropbox P3) \| \|

\| \| PDF up to 200MB - up to 50 files \| \|

\| +--------------------------------------------------------+ \|

+--------------------------------------------------------------+

How it works (3 steps) \| Features (4-6) \| FAQ \| Related tools \| SEO text

State 2 - Workspace (Preview + Options)

+------------------------------------------------------------------------+

\| \< Back \[+ Add files\] \[Undo\]\[Redo\] \[Clear all\] Help (?) \|

+---------------------------------------------------+--------------------+

\| Preview / Thumbnail grid (pdf.js) \| OPTIONS PANEL \|

\| \[file1\] \[file2\] \[file3\] ... drag to reorder \| - Mode \|

\| zoom - / + , page nav, select \| - Settings \|

\| \| - Output name \|

\| \| Summary: 3 files \|

+---------------------------------------------------+--------------------+

\| STICKY: \[ Merge PDF -\> \] (shows count and estimated size) \|

+------------------------------------------------------------------------+

Mobile: preview full width, options in bottom sheet, CTA sticky bottom.

State 3 - Processing

+---------------------------------------------+

\| Merging your files... 62% \|

\| \[=============----------\] Page 31 of 50 \|

\| Stage: Reading \> Processing \> Saving \|

\| \[ Cancel \] Tip: tab band na karein. \|

+---------------------------------------------+

- Real progress (worker se messages). Cancel immediately worker terminate karta hai aur temp OPFS clean karta hai.

- S-mode: stages "Uploading", "Processing", "Downloading result". Network error par automatic retry (2 times) phir clear message.

- Tab hidden ho to progress notification (jaha allowed).

6.4 Result Page

State 4 - Result

+-------------------------------------------------------------------+

\| (check) Aapki file taiyar hai! \|

\| merged.pdf \[rename\] 12.4 MB -\> 3.2 MB (74% chhota) \|

\| \[ Download \] \[ Share... \] \[ Save to Files \] \|

\| Preview thumbnail (first page) - click to open full preview \|

+-------------------------------------------------------------------+

\| Ab aage kya? \[Compress\] \[Protect\] \[Sign\] \[Split\] \[Edit\] (chain) \|

+-------------------------------------------------------------------+

\| Feedback: \[Thumbs up\] \[Thumbs down\] \| Privacy: file sirf aapke \|

\| device par hai. \[Is device se hatayein\] \|

\| Soft Pro note (non-intrusive) \| Related tools \|

+-------------------------------------------------------------------+

| **Element**        | **Behavior**                                                                                                                   |
|--------------------|--------------------------------------------------------------------------------------------------------------------------------|
| Download           | Primary CTA. File System Access API available ho to "Save as" dialog, warna browser download. Auto-download nahi (user click). |
| Share              | navigator.share({files}) mobile par; desktop par hidden ya "Copy"                                                              |
| Rename             | Inline edit, invalid characters block, extension fixed                                                                         |
| Size delta         | Before \> After, % saving; negative ho to "File already optimized"                                                             |
| Chain mode         | Result file OPFS me hai; next tool bina dobara select kiye khulta hai. Breadcrumb "Merge \> Compress"                          |
| Multiple outputs   | List with individual download + \[Download all (ZIP)\]                                                                         |
| Remove from device | OPFS aur recent entry delete; confirmation toast                                                                               |
| Feedback           | 1 click rating; thumbs down par optional reason chips                                                                          |
| S-mode tools       | Line: "Server se file delete ho chuki hai"                                                                                     |
| Pro note           | Sirf jab free limit ke paas ho; kabhi popup nahi                                                                               |

6.5 Preview / Viewer Page (/view-pdf aur full-screen preview)

- Full-screen viewer (pdf.js): continuous scroll, single page, two-page spread, fit width / fit page, zoom 25-400%, rotate view, dark reading mode.

- Left sidebar: thumbnails, outline/bookmarks, attachments, annotations list. Search (Ctrl+F) with highlight and result list.

- Tools in viewer: Print, Download, Open in Editor, Compress, Share. Text select aur copy. Go to page. Presentation mode.

- Keyboard: arrows, PageUp/Down, +/-, Ctrl+F, G (go to page).

- Large file: lazy page render, only visible +/-2 pages in memory.

- Password-protected file: password prompt (stays local).

6.6 Batch / Multi-file handling

- Single-file tools par multiple files drop karein to "Batch mode" (queue): sab ek hi settings se process, output ZIP.

- Free users: batch 5 files, Pro: 50+.

- Queue panel: per-file progress, failed items retry, "Download all".

7\. Complete Tool Catalog

**Legend:** Mode D = Device-only (browser), S = Server-assisted (stateless worker). Phase P1 = MVP, P2 = Editor aur advanced client tools, P3 = Server tools aur niche tools. Free/Pro limits Section 11 me.

7.1 Organize

| **Tool**                                          | **URL**              | **Mode** | **Engine**            | **Phase** |
|---------------------------------------------------|----------------------|----------|-----------------------|-----------|
| Merge PDF                                         | /merge-pdf           | D        | pdf-lib               | P1        |
| Assemble PDF (multi-doc, move pages between)      | /assemble-pdf        | D        | pdf-lib + pdf.js      | P2        |
| Split PDF                                         | /split-pdf           | D        | pdf-lib               | P1        |
| Rearrange PDF pages                               | /rearrange-pdf-pages | D        | pdf-lib               | P1        |
| Remove PDF pages                                  | /remove-pdf-pages    | D        | pdf-lib               | P1        |
| Extract PDF pages                                 | /extract-pdf-pages   | D        | pdf-lib               | P1        |
| Rotate PDF pages                                  | /rotate-pdf-pages    | D        | pdf-lib               | P1        |
| Pages per sheet (N-up)                            | /pages-per-sheet     | D        | pdf-lib               | P2        |
| Halve PDF pages                                   | /halve-pdf-pages     | D        | pdf-lib               | P2        |
| Bookmark PDF                                      | /bookmark-pdf        | D        | pdf-lib               | P2        |
| Extract PDF images                                | /extract-images      | D        | pdf.js                | P2        |
| Copy from PDF (text, tables, pictures; scans too) | /copy-from-pdf       | D        | pdf.js + Tesseract.js | P2        |

7.2 Edit

| **Tool**                        | **URL**               | **Mode** | **Engine**                | **Phase** |
|---------------------------------|-----------------------|----------|---------------------------|-----------|
| Edit PDF (full editor)          | /edit-pdf             | D        | pdf.js + Fabric + pdf-lib | P2        |
| Annotate PDF                    | /annotate-pdf         | D        | Editor core               | P2        |
| Fill out PDF forms              | /fill-out-pdf         | D        | pdf-lib forms             | P1        |
| Make PDF fillable               | /make-pdf-fillable    | D        | pdf-lib                   | P2        |
| Add watermark                   | /add-watermark        | D        | pdf-lib                   | P1        |
| Add page numbers                | /add-page-numbers     | D        | pdf-lib                   | P1        |
| Header & footer                 | /add-header-footer    | D        | pdf-lib                   | P1        |
| Overlay PDF                     | /overlay-pdf          | D        | pdf-lib                   | P2        |
| Crop PDF                        | /crop-pdf             | D        | pdf-lib                   | P1        |
| Change PDF page size            | /change-pdf-page-size | D        | pdf-lib                   | P2        |
| Change PDF document information | /change-pdf-doc-info  | D        | pdf-lib                   | P1        |

7.3 Create

| **Tool**                             | **URL**                   | **Mode** | **Engine**                 | **Phase** |
|--------------------------------------|---------------------------|----------|----------------------------|-----------|
| Create PDF (blank/design)            | /create-pdf               | D        | Editor core                | P2        |
| Write PDF (word-processor style)     | /write-pdf                | D        | Rich text editor + pdf-lib | P2        |
| Scan to PDF (camera)                 | /scan-pdf                 | D        | Camera API + edge detect   | P1        |
| Webpage to PDF                       | /webpage-to-pdf           | S        | Headless Chromium (worker) | P3        |
| Images to PDF                        | /images-to-pdf            | D        | pdf-lib                    | P1        |
| Create photo collage                 | /create-photo-collage     | D        | Canvas                     | P3        |
| Create card (postcards, invitations) | /create-card              | D        | Canvas + pdf-lib           | P3        |
| Create PDF form                      | /create-fillable-pdf-form | D        | pdf-lib                    | P3        |
| Create resume / job application      | /create-resume            | D        | Templates + pdf-lib        | P3        |
| Generate QR code                     | /generate-qr-code         | D        | qrcode lib                 | P2        |

7.4 Invoices (India-focused)

| **Tool**                                     | **URL**                    | **Mode** | **Engine**             | **Phase** |
|----------------------------------------------|----------------------------|----------|------------------------|-----------|
| Create invoice (GST ready)                   | /create-invoice            | D        | Templates + pdf-lib    | P3        |
| Create invoice visually                      | /create-invoice-visually   | D        | Editor core            | P3        |
| Create electronic invoice (Factur-X/ZUGFeRD) | /create-electronic-invoice | S        | Worker (PDF/A-3 + XML) | P3        |
| PDF invoice to e-invoice                     | /pdf-to-e-invoice          | S        | Worker                 | P3        |
| XML e-invoice to PDF                         | /xml-invoice-to-pdf        | D        | XML parse + pdf-lib    | P3        |
| Validate e-invoice                           | /validate-e-invoice        | S        | Worker                 | P3        |

7.5 Optimize & Repair

| **Tool**                                         | **URL**               | **Mode**      | **Engine**                                    | **Phase** |
|--------------------------------------------------|-----------------------|---------------|-----------------------------------------------|-----------|
| Compress PDF                                     | /compress-pdf         | D (+S strong) | Canvas re-encode, pdf-lib; worker qpdf/pdfcpu | P1        |
| Compress to target size (100KB / 200KB / custom) | /compress-pdf-to-size | D             | Iterative compress                            | P2        |
| Web optimize (linearize)                         | /web-optimize-pdf     | D             | qpdf-wasm                                     | P3        |
| PDF OCR (searchable)                             | /ocr-pdf              | D             | Tesseract.js                                  | P2        |
| Repair PDF                                       | /repair-pdf           | D             | qpdf-wasm (fallback S)                        | P3        |
| Rasterize PDF                                    | /rasterize-pdf        | D             | pdf.js + pdf-lib                              | P2        |
| Flatten PDF                                      | /flatten-pdf          | D             | pdf-lib                                       | P2        |
| PDF to PDF/A                                     | /pdf-to-pdfa          | S             | Worker                                        | P3        |

7.6 Security & Privacy

| **Tool**                                | **URL**              | **Mode** | **Engine**                  | **Phase** |
|-----------------------------------------|----------------------|----------|-----------------------------|-----------|
| Protect PDF (password, permissions)     | /lock-pdf            | D        | qpdf-wasm AES-256           | P1        |
| Unlock PDF                              | /unlock-pdf          | D        | qpdf-wasm                   | P1        |
| Sign PDF (visual signature)             | /sign-pdf            | D        | Editor core                 | P1        |
| Digital signature (certificate, PAdES)  | /digital-signature   | D        | pkijs                       | P3        |
| Redact PDF                              | /redact-pdf          | D        | pdf.js + rasterize pipeline | P3        |
| Remove PDF metadata                     | /remove-pdf-metadata | D        | pdf-lib                     | P1        |
| Generate password                       | /generate-password   | D        | Web Crypto                  | P1        |
| Request signature (send link to others) | /request-signature   | S        | Worker + Turso (Pro)        | P3        |

7.7 View & Check

| **Tool**                    | **URL**                     | **Mode** | **Engine**       | **Phase** |
|-----------------------------|-----------------------------|----------|------------------|-----------|
| View PDF                    | /view-pdf                   | D        | pdf.js           | P1        |
| Compare PDFs                | /compare-pdf                | D        | pdf.js + diff    | P3        |
| Search in PDFs (many files) | /search-pdf                 | D        | pdf.js text      | P2        |
| Check PDF/A & PDF/UA        | /validate-pdfa              | S        | veraPDF (worker) | P3        |
| Verify PDF signatures       | /verify-pdf-signatures      | D        | pkijs            | P3        |
| Set viewer preferences      | /set-pdf-viewer-preferences | D        | pdf-lib          | P2        |

7.8 Convert to PDF

| **Tool**                                 | **URL**            | **Mode** | **Engine**            | **Phase** |
|------------------------------------------|--------------------|----------|-----------------------|-----------|
| Word to PDF (DOC, DOCX)                  | /word-to-pdf       | S        | LibreOffice           | P3        |
| PowerPoint to PDF (PPT, PPTX)            | /powerpoint-to-pdf | S        | LibreOffice           | P3        |
| Excel to PDF (XLS, XLSX)                 | /excel-to-pdf      | S        | LibreOffice           | P3        |
| Publisher to PDF (PUB)                   | /publisher-to-pdf  | S        | LibreOffice (limited) | P3        |
| OpenDocument to PDF (ODT, ODS, ODP, ODG) | /odt-to-pdf etc.   | S        | LibreOffice           | P3        |
| RTF to PDF                               | /rtf-to-pdf        | S        | LibreOffice           | P3        |
| EPUB to PDF                              | /epub-to-pdf       | S        | Worker                | P3        |
| Text to PDF                              | /txt-to-pdf        | D        | pdf-lib + fonts       | P2        |
| Markdown to PDF                          | /markdown-to-pdf   | D        | marked + pdf-lib      | P2        |
| HTML to PDF                              | /html-to-pdf       | S        | Headless Chromium     | P3        |
| JPG to PDF                               | /jpg-to-pdf        | D        | pdf-lib               | P1        |
| PNG to PDF                               | /png-to-pdf        | D        | pdf-lib               | P1        |
| WEBP to PDF                              | /webp-to-pdf       | D        | Canvas + pdf-lib      | P1        |
| HEIC to PDF                              | /heic-to-pdf       | D        | HEIC WASM decoder     | P2        |
| SVG to PDF                               | /svg-to-pdf        | D        | Canvas + pdf-lib      | P2        |
| TIFF to PDF                              | /tiff-to-pdf       | D        | UTIF + pdf-lib        | P2        |
| Universal converter page                 | /convert-to-pdf    | D/S      | Routes by file type   | P1        |

7.9 Convert from PDF

| **Tool**                            | **URL**                    | **Mode**    | **Engine**                 | **Phase** |
|-------------------------------------|----------------------------|-------------|----------------------------|-----------|
| PDF to Word (DOCX)                  | /pdf-to-word               | S           | LibreOffice / custom       | P3        |
| PDF to PowerPoint (PPTX)            | /pdf-to-powerpoint         | S           | Worker                     | P3        |
| PDF to Excel (XLSX)                 | /pdf-to-excel              | S           | Table extraction (worker)  | P3        |
| PDF to JPG                          | /pdf-to-jpg                | D           | pdf.js canvas              | P1        |
| PDF to PNG                          | /pdf-to-png                | D           | pdf.js canvas              | P1        |
| PDF to WEBP / TIFF                  | /pdf-to-webp, /pdf-to-tiff | D           | Canvas / UTIF              | P2        |
| PDF to SVG                          | /pdf-to-svg                | S           | Worker (pdftocairo-like)   | P3        |
| PDF to Text                         | /pdf-to-txt                | D           | pdf.js (OCR optional)      | P1        |
| PDF to HTML                         | /pdf-to-html               | D basic / S | pdf.js text layer / worker | P3        |
| PDF to Markdown                     | /pdf-to-markdown           | D           | pdf.js heuristics          | P3        |
| PDF to ODT / ODS / ODP / RTF / EPUB | /pdf-to-odt etc.           | S           | Worker                     | P3        |
| Universal converter page            | /convert-from-pdf          | D/S         | Routes by target format    | P1        |

7.10 Convert images and utilities

| **Tool**                                                      | **URL**                    | **Mode** | **Engine**   | **Phase** |
|---------------------------------------------------------------|----------------------------|----------|--------------|-----------|
| HEIC to JPG / PNG                                             | /heic-to-jpg, /heic-to-png | D        | WASM decoder | P1        |
| WEBP to JPG / PNG                                             | /webp-to-jpg, /webp-to-png | D        | Canvas       | P1        |
| Resize / compress image to KB (photo and signature for forms) | /resize-image-kb           | D        | Canvas       | P2        |
| Passport photo maker (India sizes)                            | /passport-photo            | D        | Canvas       | P3        |
| Scan to PDF (camera)                                          | /scan-pdf                  | D        | Camera API   | P1        |

**Total:** lagbhag 100+ tool pages (formats ke variants ko alag SEO pages mante hue), lekin core engines sirf ~25. Isliye ToolShell + config pattern zaroori hai.

8\. Detailed Tool Specifications

Har spec me: input, options, preview, validation, errors, output. Common behavior jo sab tools par lagu: file type check magic bytes se (extension par bharosa nahi), encrypted PDF par password prompt, corrupt file par Repair suggest, output name default "\<original\>-\<tool\>.pdf".

8.1 Organize tools

Merge PDF

|                      |                                                                                                                                                                                  |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Input**            | 2 se 50 PDF (images bhi allowed: auto Images to PDF). Total size device limit tak.                                                                                               |
| **Preview**          | File cards grid: thumbnail pehla page, naam, pages, size. Drag-reorder (touch par long-press + up/down buttons). Card click karne par page-level expand (pages select/deselect). |
| **Per-file actions** | Rotate, Remove, Select page range (1-3, 5), Unlock (agar encrypted), Replace.                                                                                                    |
| **Options**          | Merge all / selected pages; Sort A-Z, Z-A, date; Add bookmarks per file; Insert blank page between files; Keep form fields or flatten; Output name.                              |
| **Validations**      | Kam se kam 2 files (ya 1 file ke multiple page ranges); locked file par password zaroori; unsupported file alert.                                                                |
| **Errors**           | File corrupt: "Ye file khul nahi rahi" + Repair option; memory kam: "File badi hai, kam files select karein".                                                                    |
| **Output**           | Single merged PDF; summary "5 files, 42 pages".                                                                                                                                  |

Split PDF

|                  |                                                                                                                                                                                                                                                                                                                               |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Modes (tabs)** | 1\) By range: "1-5, 8, 10-end" (custom ranges list, har range alag file ya ek file). 2) Every N pages. 3) By bookmarks (top-level). 4) By file size (max MB per part). 5) Visual select: thumbnails me page ke beech scissors icon click karke cut points. 6) Odd/Even. 7) Extract blank-page separators (blank page detect). |
| **Preview**      | Thumbnail strip with cut markers and color-coded parts; live count "3 files banengi".                                                                                                                                                                                                                                         |
| **Validations**  | Range page count ke andar; overlap warning; bookmarks na ho to tab disabled.                                                                                                                                                                                                                                                  |
| **Output**       | 1 file = direct download; multiple = ZIP (fflate) + individual download list. Naming: name_part1.pdf.                                                                                                                                                                                                                         |

Rotate / Rearrange / Remove / Extract (Page-grid family)

|                    |                                                                                                                                                      |
|--------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Component**      | Ek hi PageGrid component, alag presets. Sab pages thumbnails me.                                                                                     |
| **Common actions** | Select (click/shift-click/Ctrl+A, range input), drag reorder, rotate 90 left/right per page ya selected, delete, duplicate, insert blank, undo/redo. |
| **Rotate preset**  | Rotate all / selected / odd / even buttons; live thumbnail rotation.                                                                                 |
| **Remove preset**  | Select to delete, ya type "2,5-7"; "Remove blank pages" auto-detect.                                                                                 |
| **Extract preset** | Selected pages se naya PDF; option "ek page = ek file".                                                                                              |
| **Large docs**     | Virtualized grid; thumbnails lazy; zoom slider for thumbnail size.                                                                                   |
| **Safety**         | Sab pages delete ho to Apply disabled.                                                                                                               |

Assemble PDF

|             |                                                                                                                                                    |
|-------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| **Concept** | Multiple documents ek hi screen me, columns ki tarah. Pages ek document se doosre me drag; new document column banayein; sabko alag save ya merge. |
| **Options** | Zipper merge (alternate pages, jaise front/back scans), reverse, save all as ZIP.                                                                  |

Pages per sheet / Halve / Overlay / Crop / Page size

|                      |                                                                                                                |
|----------------------|----------------------------------------------------------------------------------------------------------------|
| **Pages per sheet**  | 2, 4, 6, 9, 16 per sheet; orientation, order (row/column), margins, spacing, borders; live preview of sheet.   |
| **Halve pages**      | Vertical ya horizontal cut; scanned book pages (left/right order, reverse).                                    |
| **Overlay**          | Base PDF aur overlay PDF; page mapping (all / first / odd / custom); position, opacity; foreground/background. |
| **Crop**             | Visual crop box drag; margins numeric; apply to all / selected; auto-detect margins; shows before/after.       |
| **Change page size** | A3/A4/A5/Letter/Legal/custom mm; scale content (fit/fill/none); unify mixed sizes.                             |

Bookmark PDF / Extract images / Copy from PDF

|                    |                                                                                                                                 |
|--------------------|---------------------------------------------------------------------------------------------------------------------------------|
| **Bookmark**       | Tree editor: add, rename, nest (drag), set target page, import existing, remove all.                                            |
| **Extract images** | Sab embedded images grid; select; format original/PNG/JPG; min size filter; ZIP download.                                       |
| **Copy from PDF**  | Click paragraph/table/list/picture on page to select; copy as text, Markdown, CSV/Excel (tables). Scan pages par OCR on-demand. |

8.2 Edit tools

8.2.1 Edit PDF (flagship editor)

Editor layout (desktop)

+--------------------------------------------------------------------------------+

\| Logo \| File name (rename) \| Undo Redo \| Zoom \[-\] 100% \[+\] Fit \| Pages 3/12 \| \[Download\]\|

+--------------------------------------------------------------------------------+

\| TOOLBAR: Select \| Text \| Image \| Shape \| Draw \| Highlight \| Whiteout \| Sign \| Form \|

\| Link \| Note \| Stamp \| Page ops \| Find&Replace \| More \|

+--------+------------------------------------------------------+----------------+

\| Thumbs \| \| PROPERTIES \|

\| p1 \| CANVAS (page render + objects) \| Font, size \|

\| p2 \| \| Color, bold \|

\| p3 \| \[floating mini toolbar over selected obj\] \| Align, opacity \|

\| + page \| \| Layer order \|

+--------+------------------------------------------------------+----------------+

\| Status: Draft saved on this device \| Shortcuts (?) \|

+--------------------------------------------------------------------------------+

| **Tool**                               | **Behavior**                                                                                                                                                                                                                                                                                                                                           |
|----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Select / Move                          | Click object select, drag move, handles resize/rotate, shift for aspect ratio, multi-select box, arrow-key nudge, snap guides.                                                                                                                                                                                                                         |
| Edit existing text                     | Text layer (pdf.js) detect karke click par text block edit mode. Approach: original text area whiteout + naya text same position par, font match (standard fonts, embedded font agar subset allow kare, warna closest font suggest). Limit: paragraph reflow auto nahi; line-by-line edit. UI me clear message "Is text ka font mil gaya / nahi mila". |
| Add text                               | Click-to-type, drag box. Font family (Noto Sans, Noto Sans Devanagari, Serif, Mono, Handwriting), size, color, bold/italic/underline, align, line spacing, opacity, background fill, border.                                                                                                                                                           |
| Images                                 | Upload/paste; resize, rotate, crop, flip, opacity, replace, send to back/front. Background remove (Pro, optional P3).                                                                                                                                                                                                                                  |
| Shapes                                 | Rectangle, ellipse, line, arrow, polygon, checkmark/cross; fill, stroke, width, dash.                                                                                                                                                                                                                                                                  |
| Draw                                   | Freehand pen, pressure smoothing, color/width; eraser for strokes.                                                                                                                                                                                                                                                                                     |
| Highlight / Underline / Strike         | Text select karke apply; color presets; real PDF annotations (editable in other readers).                                                                                                                                                                                                                                                              |
| Whiteout / Erase                       | Rectangle fill (page background color eyedropper); option "Permanently remove underlying text" (redact-lite).                                                                                                                                                                                                                                          |
| Sticky note / Comment                  | Note icon + popup text; comment list in sidebar.                                                                                                                                                                                                                                                                                                       |
| Forms                                  | Text field, checkbox, radio group, dropdown, date, signature field; name/required/default/tab order.                                                                                                                                                                                                                                                   |
| Links                                  | URL, email, go-to-page; shape ya text par.                                                                                                                                                                                                                                                                                                             |
| Sign                                   | Draw/Type/Upload saved signatures, initials, date, name auto-field.                                                                                                                                                                                                                                                                                    |
| Stamps                                 | Approved, Rejected, Draft, Confidential, Paid, Received, Custom date stamp; custom image stamp.                                                                                                                                                                                                                                                        |
| Page operations (thumbnail panel)      | Add blank, insert from another PDF, delete, duplicate, rotate, reorder (drag).                                                                                                                                                                                                                                                                         |
| Find & Replace                         | Text search across document; replace one/all (same font rules as text edit).                                                                                                                                                                                                                                                                           |
| Header/Footer, Page numbers, Watermark | Quick access menu linking to those tool panels inside editor.                                                                                                                                                                                                                                                                                          |
| Layers panel                           | Objects list per page, lock, hide, reorder.                                                                                                                                                                                                                                                                                                            |

Editor UX rules

|                               |                                                                                                                                                                                         |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Undo/Redo**                 | Unlimited (command stack), Ctrl+Z / Ctrl+Shift+Z, har action grouped.                                                                                                                   |
| **Autosave**                  | Har 5 second ya change par IndexedDB me draft (objects JSON + original file reference). Reopen par "Resume draft?"                                                                      |
| **Shortcuts**                 | V select, T text, I image, H highlight, D draw, Delete, Ctrl+C/V/D, Ctrl+A, +/- zoom, ? shows cheat sheet.                                                                              |
| **Context menu**              | Right-click: copy, paste, duplicate, bring front/back, lock, delete, properties. Mobile: long-press.                                                                                    |
| **Mobile mode**               | Simplified bottom toolbar (Text, Sign, Draw, Image, More), pinch-zoom, two-finger pan, properties in bottom sheet, larger handles.                                                      |
| **Accessibility**             | Keyboard object navigation (Tab), arrow nudge, ARIA labels, screen reader text for toolbar.                                                                                             |
| **Export**                    | Download PDF: objects pdf-lib se native PDF content/annotations me convert. Options: Flatten annotations, Keep editable, Compress on save.                                              |
| **Hindi support**             | Devanagari shaping correct (embedded Noto Sans Devanagari with proper shaping engine such as fontkit/HarfBuzz WASM), RTL not in v1.                                                     |
| **Limitations (honest copy)** | Scanned PDF ka text edit OCR ke baad hi; complex layouts/embedded subset fonts me exact match na ho sake; password-protected edit restrictions respect (owner password hai to warning). |
| **Performance**               | Sirf visible pages render; objects per page Fabric canvas; max 500 pages editor me (beyond: warn).                                                                                      |

Fill out PDF / Make PDF fillable

|                      |                                                                                                                                                                                  |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Fill out**         | Existing form fields highlight; Tab navigation; checkbox/radio/dropdown; date picker; auto-fill saved info (name, address, email) from local profile; Flatten after fill option. |
| **Non-fillable PDF** | "Add text anywhere" mode with auto field-detect (lines/boxes) suggestion.                                                                                                        |
| **Make fillable**    | Auto-detect likely fields (underlines, boxes) + manual add; field properties; export as AcroForm.                                                                                |

Watermark / Page numbers / Header & footer

|                     |                                                                                                                                                          |
|---------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Input**           | Single PDF.                                                                                                                                              |
| **Watermark**       | Text (font, size, color, opacity, rotation, position 9-grid, tile) ya image/logo; behind or over content; layout all/odd/even/range/first-page-excluded. |
| **Page numbers**    | Formats: 1, Page 1, 1/N, Page 1 of N, i, I, a; start number; position 9-grid + margins; font; skip first page; Hindi digits optional.                    |
| **Header & footer** | Left/center/right text with variables: {page}, {pages}, {date}, {filename}, {title}.                                                                     |
| **Preview**         | Live canvas preview on selected sample page; thumbnails strip.                                                                                           |

Change document information

|            |                                                                                                 |
|------------|-------------------------------------------------------------------------------------------------|
| **Fields** | Title, Author, Subject, Keywords, Creator, Producer, dates; "Remove all metadata" quick toggle. |

8.3 Security tools

Protect PDF

|                |                                                                                                                                                                                           |
|----------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Options**    | Open password (strength meter, show/hide, generate button), Owner password, permissions (print, copy, edit, annotate, fill forms, accessibility), encryption AES-256 (default) / AES-128. |
| **Validation** | Password min 6 characters (recommend 12+); confirm field; warns "Password bhool gaye to recover nahi hoga".                                                                               |
| **Note**       | qpdf-wasm se encrypt; pdf-lib encryption support nahi karta.                                                                                                                              |

Unlock PDF

|            |                                                                                                                                               |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| **Modes**  | 1\) Open password maloom hai: enter and remove. 2) Owner restrictions (print/copy/edit disabled) hatana jab PDF bina open-password khulta ho. |
| **Policy** | Unknown open-password crack karne ka feature NAHI. Disclaimer: "Sirf apni files ya jinki aapko permission hai unhe unlock karein."            |

Sign PDF

|                                 |                                                                                                                                                                                            |
|---------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Create signature**            | Draw (mouse/touch/stylus), Type (8 script fonts incl. Hindi style), Upload image (background auto-remove). Save multiple, device par encrypted storage.                                    |
| **Place**                       | Click to place, drag/resize/rotate; apply on multiple pages; auto fields: Initials, Date, Name, Text, Checkmark.                                                                           |
| **Output**                      | Flatten signature into page. Option "Add signature field" (visual).                                                                                                                        |
| **Digital signature (P3)**      | Certificate (.pfx/.p12) upload se PAdES basic signature, reason/location/contact, visible/invisible, timestamp (apna ya optional TSA).                                                     |
| **Request signature (P3, Pro)** | Doc link (encrypted, expiring) doosre ko bhejna, signing order, reminders, audit trail. Yeh S-mode tool hai aur file server par rehti hai jab tak sign na ho; alag consent screen zaroori. |

Redact PDF

|                  |                                                                                                                                                                                            |
|------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Methods**      | 1\) Draw box. 2) Search text/regex. 3) Pattern presets: Aadhaar (12 digits), PAN, phone, email, IFSC, account number, date of birth.                                                       |
| **Preview**      | Marked areas dikhte hain (red overlay); review list with check/uncheck.                                                                                                                    |
| **Secure apply** | Default "Secure mode": affected pages ko image (rasterize) me convert karke black box burn-in, taaki underlying text recover na ho. Option "Keep text elsewhere" (selective rasterize) P3. |
| **Warning**      | "Redaction permanent hai. Original file alag save rakhein."                                                                                                                                |
| **Verification** | Output me redacted text search test auto-run: "0 matches found".                                                                                                                           |

Remove metadata / Generate password

|                       |                                                                                                                                                      |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Remove metadata**   | Preview of found metadata (author, software, GPS from images optional, XMP) aur remove all; output with before/after list.                           |
| **Generate password** | Length 8-64, character sets, pronounceable, passphrase (Hindi/English word list), copy button, strength meter. Web Crypto (random), kuch store nahi. |

8.4 Optimize tools

Compress PDF

|                          |                                                                                                                                                                                                       |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Presets**              | Low compression (best quality), Recommended, Extreme; Custom: image quality slider (30-95), downscale DPI (72/96/150/200/300), grayscale, remove metadata, remove embedded thumbnails/unused objects. |
| **Target size**          | "Compress to under 100 KB / 200 KB / 500 KB / 1 MB / custom": iterative quality+DPI loop with progress; fail message agar possible nahi ("Is size tak nahi ja sakta, closest 140 KB").                |
| **Preview**              | Estimated size, before/after quality compare slider on a sample page.                                                                                                                                 |
| **Device mode**          | Images canvas se re-encode (JPEG/WebP), pdf-lib object streams. Text-only PDF me kam saving; "Already optimized" message agar \<5% saving.                                                            |
| **Server mode (strong)** | Optional "Better compression (server)": qpdf + pdfcpu + image downsampling on worker; clear badge.                                                                                                    |
| **Output**               | Result page me size delta aur % saving; agar bada ho gaya to original return.                                                                                                                         |

PDF OCR

|                        |                                                                                                                                                                                                                          |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Input**              | Scanned PDF ya images.                                                                                                                                                                                                   |
| **Options**            | Languages (English, Hindi, Marathi, Bengali, Tamil, Telugu, Gujarati, Urdu... multi-select; model files lazy download), page range, deskew, rotate auto, DPI 150/300; output: Searchable PDF / Text / Word-like (S, P3). |
| **Preview**            | Per-page OCR confidence, text overlay toggle.                                                                                                                                                                            |
| **Notes**              | Mobile par slow; progress per page; background Web Worker; tip box accuracy ke liye (300 DPI, straight scan).                                                                                                            |
| **Download of models** | First use par "Hindi OCR data (12 MB) download ho raha hai" (cached for offline).                                                                                                                                        |

Rasterize / Flatten / Repair / Web optimize / PDF/A

|                  |                                                                                                   |
|------------------|---------------------------------------------------------------------------------------------------|
| **Rasterize**    | Pages ko images banakar naya PDF (non-editable); DPI choice.                                      |
| **Flatten**      | Form fields aur annotations ko page content me merge.                                             |
| **Repair**       | qpdf rebuild xref; agar fail ho to S-mode more aggressive; result report "Recovered 18/20 pages". |
| **Web optimize** | Linearize for fast web view.                                                                      |
| **PDF/A**        | Level 1b/2b/3b choose; embedded fonts, color profile; conformance report (S-mode).                |

8.5 View & Check tools

Compare PDFs

|              |                                                                                         |
|--------------|-----------------------------------------------------------------------------------------|
| **Input**    | Two PDFs (Original, Revised).                                                           |
| **Views**    | Side-by-side (sync scroll), Overlay (red/green diff), Text-diff list.                   |
| **Controls** | Sensitivity, ignore whitespace/case, page mapping, change list jump, export report PDF. |

Search in PDFs / Viewer preferences / Verify signatures / Check PDF/A

|                         |                                                                                                                               |
|-------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| **Search in PDFs**      | Multiple PDFs select, query ya regex, results with page and context snippet, click to open at page. Index in-memory (device). |
| **Viewer preferences**  | Initial page layout, zoom, window title show, hide toolbars, fullscreen.                                                      |
| **Verify signatures**   | Signer, time, certificate chain status, "document modified after signing?" indicator.                                         |
| **Check PDF/A, PDF/UA** | Report with pass/fail rules grouped, page references.                                                                         |

8.6 Convert tools

Images to PDF (JPG, PNG, WEBP, HEIC, TIFF, SVG)

|             |                                                                                                                                                                       |
|-------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Input**   | Multiple images; reorder; rotate; crop each.                                                                                                                          |
| **Options** | Page size (A4, Letter, Fit to image), orientation, margin (none/small/big), image quality, one image per page or multiple (grid), background color, add page numbers. |
| **Mobile**  | Camera capture multiple; auto edge detection (scan mode).                                                                                                             |

PDF to images (JPG, PNG, WEBP, TIFF)

|             |                                                                                                                                |
|-------------|--------------------------------------------------------------------------------------------------------------------------------|
| **Options** | Format, DPI (72/150/300/600), page range or selected, transparent background (PNG), quality; extract-embedded vs render pages. |
| **Output**  | Single page direct; multiple ZIP; progress per page; memory-safe sequential render.                                            |

Office to PDF (Word, Excel, PowerPoint, ODF, RTF, Publisher)

|             |                                                                                                                                      |
|-------------|--------------------------------------------------------------------------------------------------------------------------------------|
| **Mode**    | S-mode (LibreOffice). Badge "Server processing - file deleted right after".                                                          |
| **Options** | Excel: fit sheet to page width, all sheets/selected; PowerPoint: slides per page/notes; Word: PDF/A option, quality (standard/high). |
| **Limits**  | Size 50MB free; timeout 120 s; fonts note ("Custom fonts ho to layout badal sakta hai"), macros disabled.                            |
| **Errors**  | Password-protected Office file: error + instruction; unsupported features: warning.                                                  |

PDF to Office (Word, Excel, PowerPoint)

|                 |                                                                                                                                                 |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| **Mode**        | S-mode.                                                                                                                                         |
| **Word**        | Options: "Keep layout exact" (text boxes) vs "Editable flow text"; OCR toggle for scanned.                                                      |
| **Excel**       | Table detection, each table to sheet; merge pages; number cleanup.                                                                              |
| **PowerPoint**  | Page = slide; text editable where possible; else image.                                                                                         |
| **Honest note** | "PDF se Word 100% perfect nahi hota. Complex layout me thoda formatting fix karna pad sakta hai." Quality preview before download (first page). |

PDF to Text / HTML / Markdown / EPUB / RTF / SVG

|                            |                                                                                          |
|----------------------------|------------------------------------------------------------------------------------------|
| **Text**                   | Device: pdf.js text extraction, reading-order options, keep layout toggle, OCR fallback. |
| **HTML / Markdown**        | Heading/list heuristics; images extraction ZIP.                                          |
| **EPUB / RTF / ODT / SVG** | S-mode worker.                                                                           |

Universal converter pages

|                                           |                                                                                                        |
|-------------------------------------------|--------------------------------------------------------------------------------------------------------|
| **/convert-to-pdf and /convert-from-pdf** | Drop any file; format auto-detect; target picker; routes to right tool; recommended for Home hero too. |

8.7 Create tools

Create PDF / Write PDF

|                |                                                                                                                                                                                                                   |
|----------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Create PDF** | Blank page or template (Letter, Notes, Planner, Invoice, Resume); opens in Editor with page size options.                                                                                                         |
| **Write PDF**  | Rich text editor: headings, bold/italic/underline, lists, tables, images, page breaks, header/footer, fonts (Hindi), page numbers; templates (letter, application, offer, report); live page preview; export PDF. |

Scan to PDF (camera)

|            |                                                                                                                                                                      |
|------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Flow**   | Camera access, auto edge detect and perspective correct, filters (Original, Magic color, B&W, Grayscale), multi-page capture, reorder, crop, OCR toggle, export PDF. |
| **Mobile** | Primary use case; also "Upload from gallery".                                                                                                                        |

Webpage to PDF / HTML to PDF

|             |                                                                                                                                |
|-------------|--------------------------------------------------------------------------------------------------------------------------------|
| **Input**   | URL (or pasted HTML).                                                                                                          |
| **Options** | Page size, orientation, margins, include background, remove ads/cookie banners (best effort), screenshot full page, wait time. |
| **Mode**    | S-mode; SSRF protection (block private IPs), URL allowlist rules, timeout 30 s.                                                |

Photo collage / Create card / Create PDF form / Resume

|              |                                                                                                               |
|--------------|---------------------------------------------------------------------------------------------------------------|
| **Collage**  | Templates grid, passport-photo sheets, polaroid, text and stickers, export PDF/JPG/PNG.                       |
| **Card**     | Greeting, invitation, voucher templates; Hindi festival templates; folded print layouts; mail merge from CSV. |
| **PDF form** | Visual form builder with calculations and validation.                                                         |
| **Resume**   | Step-by-step form, 8 templates, live preview, PDF export; no signup; data local.                              |

Generate QR code

|           |                                                                          |
|-----------|--------------------------------------------------------------------------|
| **Types** | URL, text, WiFi, UPI payment, vCard, email, phone, WhatsApp link.        |
| **Style** | Colors, dot style, logo in center, error correction; output PNG/SVG/PDF. |

8.8 Invoice tools (GST ready)

Create invoice

|                |                                                                                                                                                                                                                                                                                                                        |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Fields**     | Seller details (name, GSTIN, address, logo), buyer (name, GSTIN, billing/shipping), invoice no/date/due date, place of supply, items (description, HSN/SAC, qty, unit, rate, discount, GST% CGST/SGST/IGST auto by state), totals, round-off, amount in words (English/Hindi), bank details, UPI QR, terms, signature. |
| **Behavior**   | Calculations live, multiple tax slabs summary, templates (4-6), currency INR (others optional), save business profile on device, duplicate previous invoice from local history, auto invoice numbering.                                                                                                                |
| **Output**     | PDF; optional Excel/CSV export of items.                                                                                                                                                                                                                                                                               |
| **Legal note** | Government e-invoice (IRN) portal integration is out of scope; tool sirf invoice document banata hai. Disclaimer dikhayein.                                                                                                                                                                                            |

E-invoice tools

|                    |                                                                                          |
|--------------------|------------------------------------------------------------------------------------------|
| **Create/convert** | Factur-X/ZUGFeRD/XRechnung (EU standards) ke liye PDF/A-3 + XML embed (S-mode).          |
| **XML to PDF**     | Readable PDF from e-invoice XML (UBL/CII), device-only.                                  |
| **Validate**       | Rules check and error list (S-mode).                                                     |
| **Priority**       | India users ke liye low priority; EU users ke liye SEO opportunity. P3 me decide karein. |

9\. Static aur Supporting Pages

About (/about)

|                        |                                                                                                                                                                                                       |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Trust aur brand story.                                                                                                                                                                                |
| **Content / Sections** | Mission, kahani (kyun banaya), privacy-first approach explained simply (diagram: file browser se bahar nahi jaati), numbers (real), team, tech principles, contact link, "Made in India" (agar lage). |

Contact (/contact)

|                        |                                                                                                                                                                                                                                                                                                                                                                                                               |
|------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Support aur business queries.                                                                                                                                                                                                                                                                                                                                                                                 |
| **Content / Sections** | Form: Name, Email, Category (Bug, Feature request, Billing, Business/API, Legal/DMCA, Other), Message, Optional screenshot attach (client-validated; file size limit), consent checkbox. Spam protection (self-hosted honeypot + rate limit; CAPTCHA third-party avoid). Support email, response time (24-48h), social links, office address (legal), Turso me contact_messages. Success page with ticket id. |

Help Center / FAQ (/help, /faq)

|                        |                                                                                                                                                                                                                                             |
|------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Self-service support.                                                                                                                                                                                                                       |
| **Content / Sections** | Search, categories (Getting started, Each tool guides, Account & billing, Privacy & security, Troubleshooting), article template with steps + screenshots + related, video how-tos, "Was this helpful?", contact CTA. FAQ page with schema. |

Pricing (/pricing)

|                        |                                                                                                                                                                                                                                   |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Conversion.                                                                                                                                                                                                                       |
| **Content / Sections** | Free vs Pro table, monthly/yearly toggle, INR (UPI/cards via Razorpay) aur USD (Stripe), feature comparison, limits transparent, FAQ (cancel anytime, refund), team/business contact, "Device-only tools hamesha free" statement. |

Security & Trust (/security)

|                        |                                                                                                                                                                                                                                                                        |
|------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Privacy USP proof.                                                                                                                                                                                                                                                     |
| **Content / Sections** | How it works (device-only vs server tools), data flow diagram, encryption (HTTPS/HSTS), auto-delete, no logging of file content, third-party list (none), open-source libraries acknowledgements, vulnerability disclosure (security.txt), certifications (jab milen). |

Privacy Policy (/privacy-policy)

|                        |                                                                                                                                                                                                                                                                                                                         |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Legal compliance.                                                                                                                                                                                                                                                                                                       |
| **Content / Sections** | Data collected (email, usage aggregates, payment metadata, cookies), what is NOT collected (file content), purposes, retention, sharing (payment providers), user rights (access, correction, erasure, grievance), children, DPDP Act 2023 aur GDPR clauses, cross-border, contact/Data Protection contact, change log. |

Terms of Service (/terms)

|                        |                                                                                                                                                                                                                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Legal.                                                                                                                                                                                                                                                                |
| **Content / Sections** | Acceptance, service description, acceptable use (no illegal/copyright violation, no abuse), user content ownership, no warranty on conversion accuracy, limitation of liability, account/billing terms, termination, governing law (India) and jurisdiction, changes. |

Cookie Policy (/cookie-policy)

|                        |                                                                                        |
|------------------------|----------------------------------------------------------------------------------------|
| **Purpose**            | Transparency.                                                                          |
| **Content / Sections** | Cookie table (name, purpose, duration), essential vs analytics, how to change consent. |

Refund & Cancellation (/refund-policy)

|                        |                                                                                                                             |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Billing trust.                                                                                                              |
| **Content / Sections** | Free trial (if any), refund window (e.g. 7 days), cancellation steps, pro-rata rules, payment failure, contact for billing. |

DMCA / Report abuse (/dmca, /report-abuse)

|                        |                                                                                                                                                              |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Legal safe-harbor.                                                                                                                                           |
| **Content / Sections** | Takedown notice requirements, counter notice, report form, designated agent, response timeline. (Server-assisted share/signature features hone par zaroori.) |

Grievance Officer (/grievance)

|                        |                                                                                        |
|------------------------|----------------------------------------------------------------------------------------|
| **Purpose**            | India IT Rules 2021 compliance (lawyer se confirm karein).                             |
| **Content / Sections** | Officer ka naam, designation, email, address, timeline for acknowledgement/resolution. |

Accessibility statement (/accessibility)

|                        |                                                     |
|------------------------|-----------------------------------------------------|
| **Purpose**            | Inclusion.                                          |
| **Content / Sections** | WCAG 2.2 AA target, known issues, feedback contact. |

Blog and Guides (/blog)

|                        |                                                                                                                                                                                                                          |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | SEO engine.                                                                                                                                                                                                              |
| **Content / Sections** | Categories (How-to, Tips, India guides like "Aadhaar PDF 100KB kaise banayein", Compare), post template (TOC, steps, tool CTA inline, related), author, updated date, search, RSS, Hindi posts, schema (Article, HowTo). |

Changelog, Roadmap, Status

|                        |                                                                                                                                                      |
|------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Transparency.                                                                                                                                        |
| **Content / Sections** | Changelog (versioned entries), public roadmap with votes (tool_requests), status page (uptime of worker, incident history; self-hosted simple page). |

Request a Tool / Feedback (/request-a-tool)

|                        |                                                                                                                   |
|------------------------|-------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Product discovery.                                                                                                |
| **Content / Sections** | Form (title, description, use case), list of existing requests with vote button (hashed voter id), status labels. |

Install App (/install-app)

|                        |                                                                                                            |
|------------------------|------------------------------------------------------------------------------------------------------------|
| **Purpose**            | PWA adoption.                                                                                              |
| **Content / Sections** | Install steps for Android Chrome, iOS Safari (Add to Home Screen), desktop; offline benefits; screenshots. |

Login / Signup / Account (Phase 2-3)

|                        |                                                                                                                                                                                                                                                                                           |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Optional accounts for Pro.                                                                                                                                                                                                                                                                |
| **Content / Sections** | Email+password (argon2) and Google/Apple optional (self-managed OAuth), magic link, forgot password; Account: profile, plan, billing history/invoices (GST invoice for Indian customers), saved signatures sync (opt-in), usage, API keys, delete account (full erase flow), data export. |

System pages (404, 500, offline, maintenance)

|                        |                                                                                                                                           |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| **Purpose**            | Graceful failures.                                                                                                                        |
| **Content / Sections** | 404: illustration, search box, popular tools. 500: apology, retry, status link. Offline: lists tools that work offline. Maintenance: ETA. |

Legal/brand pages (Press kit, Sitemap page)

|                        |                                                                               |
|------------------------|-------------------------------------------------------------------------------|
| **Purpose**            | Optional.                                                                     |
| **Content / Sections** | Logo downloads, brand guidelines, HTML sitemap listing all tools by category. |

10\. States, Errors aur Copy

| **Case**               | **Message (EN / Hinglish)**                                                       | **Action**                                       |
|------------------------|-----------------------------------------------------------------------------------|--------------------------------------------------|
| Wrong file type        | This file type is not supported here. / Ye file type is tool me support nahi hai. | Suggest correct tool                             |
| File too large         | File is larger than your device limit (X MB). / File bahut badi hai.              | Suggest Compress / Split / Pro                   |
| Password protected     | This PDF is locked. Enter password to continue.                                   | Password field, Unlock tool link                 |
| Corrupt file           | We could not open this file. It may be damaged.                                   | Try Repair PDF                                   |
| Out of memory          | Your device ran out of memory. Try fewer or smaller files.                        | Reduce selection, desktop suggestion             |
| Storage full           | Not enough storage on this device.                                                | Clear recent files link                          |
| Cancelled              | Processing cancelled. Nothing was saved.                                          | Back to options                                  |
| Network error (S-mode) | Connection lost. Retrying...                                                      | Auto retry 2x, then manual                       |
| Daily limit            | You reached today's free limit for server tools.                                  | Reset time, Pro option, Device-only alternatives |
| Unsupported browser    | Please update your browser for this tool.                                         | List supported versions                          |
| Empty state            | No files yet. Drop a PDF to begin.                                                | Select button                                    |

Sab messages i18n keys me; Hindi translation native speaker se review. Error ke saath hamesha "Report this problem" (sirf tool id, error code, browser info bhejta hai).

11\. Monetization aur Limits

| **Feature**                                                        | **Free**                                   | **Pro**               |
|--------------------------------------------------------------------|--------------------------------------------|-----------------------|
| Device-only tools                                                  | Unlimited                                  | Unlimited             |
| Server-assisted tasks                                              | 10 per day                                 | Unlimited (fair use)  |
| File size (device tools)                                           | Device limit (50MB mobile / 200MB desktop) | Up to 500MB (desktop) |
| File size (server tools)                                           | 50 MB                                      | 500 MB                |
| Batch                                                              | 5 files                                    | 100 files             |
| OCR languages                                                      | English + Hindi                            | All                   |
| Editor extras (templates, background remove, cloud signature sync) | Basic                                      | Full                  |
| Ads                                                                | Tool landing pages par limited             | No ads                |
| Watermark on output                                                | Kabhi nahi                                 | Kabhi nahi            |
| API                                                                | \-                                         | Business plan (P3)    |

- Payments: Razorpay (UPI, cards, netbanking) + Stripe (international). GST invoice automatic.

- Ads sirf landing pages par, privacy-friendly self-served ya limited network; workspace aur result par kabhi nahi. Ads ke saath consent integration zaroori (and Vercel Pro plan).

- Pricing numbers launch se pehle market test karke tay karein.

12\. SEO, Accessibility, i18n, PWA

12.1 SEO

- Har tool ka unique URL, title (max 60 chars), meta description, H1, 600+ words helpful copy (steps, FAQ, use cases).

- Schema: SoftwareApplication, HowTo, FAQPage, BreadcrumbList, Article (blog).

- Internal linking: related tools, "next step" tools, category hubs.

- sitemap.xml (en/hi), hreflang, canonical, robots, OpenGraph images per tool.

- Core Web Vitals green; SSG for tool pages.

- India long-tail pages: "compress pdf to 100kb", "aadhaar pdf password", "jpg to pdf for form".

12.2 Accessibility

- Full keyboard operation including editor and drag-reorder alternatives.

- Screen reader labels, live regions for progress/results, focus management on state change.

- Contrast AA, text resize 200%, reduced motion, no color-only cues.

12.3 Internationalization

- English + Hindi at launch; message catalog (ICU), pluralization, number/date format.

- Tool names and SEO slugs localized; Devanagari fonts self-hosted.

- Future: Bengali, Tamil, Telugu, Marathi, Gujarati, Urdu (RTL support planning).

12.4 PWA

- Installable, offline for Device-only tools, cached WASM/pdf.js, offline page, update prompt.

- File handlers: open PDF with DocoPDF (where supported), Share Target (receive files from Android share sheet).

13\. Analytics, Privacy aur Success Metrics

- Self-hosted privacy-friendly analytics (Plausible/Matomo self-hosted ya apni Turso events table). Google Analytics nahi.

- Events (no content, no filename): tool_view, file_selected (type, size bucket, pages bucket), options_changed (names only), process_start/success/fail (duration, error code), download_click, chain_click, feedback, pro_cta_click.

- Consent ke bina sirf aggregate server-side counts.

| **Metric**                                | **Target**                                  |
|-------------------------------------------|---------------------------------------------|
| Tool completion rate (select to download) | \> 70%                                      |
| Median time to download                   | \< 30 s                                     |
| Error rate per tool                       | \< 2%                                       |
| Mobile share of completions               | Track; mobile completion \>= 60% of desktop |
| Pro conversion (of active users)          | 2-3%                                        |
| NPS / thumbs-up                           | \> 50 / \> 85%                              |
| Organic traffic growth                    | Monthly +15% (first 12 months)              |
| Core Web Vitals pass                      | \> 90% pages                                |

14\. Non-Functional Requirements

| **Area**        | **Requirement**                                                                                                                                                                                    |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Browser support | Latest 2 versions: Chrome, Edge, Firefox, Safari (iOS 16+), Samsung Internet. Graceful fallback if OPFS/File System Access missing.                                                                |
| Devices         | Android low-end (3GB RAM), iPhone, tablets, desktop. Test matrix in CI (Playwright + real device checks).                                                                                          |
| Security        | HTTPS+HSTS, strict CSP (no third-party scripts), SRI for own assets, rate limits, input validation, ZIP-bomb/PDF-bomb limits, sandboxed worker, dependency scan, secrets in env, regular pen-test. |
| Privacy         | No file content in logs, no filenames in analytics, data deletion within 30 days of request, DPDP compliance register.                                                                             |
| Reliability     | Uptime 99.9% (Vercel); worker autoscale or queue with clear "busy" message; graceful degradation to Device-only tools.                                                                             |
| Observability   | Error tracking self-hosted (GlitchTip/Sentry self-host) without payload; worker metrics; uptime checks.                                                                                            |
| Compliance      | DPDP Act 2023, IT Rules 2021 (grievance officer), GDPR-ready, PCI via payment provider.                                                                                                            |
| Licensing       | CI license scanner; no AGPL/GPL in shipped client bundle without review.                                                                                                                           |

15\. Acceptance Criteria aur QA

- Har Device-only tool par network panel me file upload request zero (automated test).

- 100-page, 50MB PDF par merge/split/rotate complete bina tab crash (mid-range Android).

- Hindi text editor aur watermark me sahi render (matras/conjuncts).

- Redacted text ko extract/search karne par 0 results.

- Protected PDF Adobe Reader, Chrome, Preview me password maangta hai.

- Compress: size kam, text selectable agar originally selectable; quality compare slider kaam kare.

- Result page par Download, Rename, Chain tool, Remove from device sab kaam kare.

- Lighthouse: Performance \>= 90 (mobile), Accessibility \>= 95, SEO \>= 95 tool pages par.

- Keyboard-only user poora Merge flow complete kar sake.

- Offline mode me Merge/Split/Rotate chale (PWA).

- Corrupt, encrypted, huge, zero-page, mixed-size PDFs ke test corpus par koi crash nahi.

16\. Roadmap aur Phases

Samay anumaan team size par depend karta hai (1-2 developers ke liye lamba). Ye approximate hain.

| **Phase**              | **Scope**                                                                                                                                                                                                                                                                                                                                                                                                         | **Approx. time** |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| P0 Setup               | Domain, GitHub repo, Vercel project, Turso DBs, design system, ToolShell, DropZone, worker infra for D-mode, CI, legal draft                                                                                                                                                                                                                                                                                      | 2-3 weeks        |
| P1 MVP                 | Home, All tools, Result page, static pages (About, Contact, Privacy, Terms, Cookies, 404). Tools: Merge, Split, Rotate, Rearrange, Remove, Extract, Images/JPG/PNG/WEBP to PDF, PDF to JPG/PNG/Text, Watermark, Page numbers, Header/footer, Crop, Doc info, Remove metadata, Protect, Unlock, Sign, Fill out, View, Compress (device), Scan to PDF, Generate password, HEIC/WEBP converters, Universal converter | 8-10 weeks       |
| P2 Editor and advanced | Edit PDF full, Annotate, Make fillable, OCR (Hindi), Compress to size, N-up, Halve, Overlay, Page size, Bookmarks, Extract images, Copy from PDF, Assemble, Flatten, Rasterize, Search PDFs, Text/Markdown/SVG/HEIC/TIFF to PDF, QR, Write PDF, Create PDF, Hindi UI, Login/Pro/payments, Help center, Blog, Pricing                                                                                              | 10-12 weeks      |
| P3 Server and niche    | Worker (Office to/from PDF, strong compress, PDF/A, repair, web-optimize, webpage/HTML to PDF), Redact, Compare, Digital signature, Verify signatures, Request signature, Invoice suite, Collage, Cards, Resume, Passport photo, API, more languages                                                                                                                                                              | 12-16 weeks      |

17\. Risks aur Open Questions

17.1 Risks

| **Risk**                                        | **Mitigation**                                                                                    |
|-------------------------------------------------|---------------------------------------------------------------------------------------------------|
| AGPL/GPL libraries                              | Avoid; license scanner in CI; commercial license if needed; lawyer review                         |
| Copying competitors                             | Sirf inspiration; apna design, icons, text. Trademark search for "DocoPDF" before buying/branding |
| Browser memory crashes                          | Web Workers, chunking, limits per device, clear error messages                                    |
| Quality expectations of PDF to Word / text edit | Honest copy, preview before download, feedback loop                                               |
| Server cost spikes (worker)                     | Daily limits, queue, autoscale caps, Pro plan, abuse protection                                   |
| Abuse (malware, spam, SSRF)                     | ClamAV, sandbox, rate limits, URL filtering, size/time limits                                     |
| Vercel plan limits / cost                       | Static-heavy design; Pro plan when commercial; monitor bandwidth                                  |
| iOS storage eviction                            | Always download/share result, PWA install prompt, warn for drafts                                 |
| Legal compliance                                | Lawyer reviews Privacy/Terms/Grievance; DPDP register                                             |
| Scope too big                                   | Config-driven tools, strict phases, ship P1 first                                                 |

17.2 Open questions (aapse confirm karne hain)

- DocoPDF naam ka trademark/domain availability check ho gaya?

- Worker server kahan host karna hai (VPS/Fly/Railway/Oracle) aur budget?

- Pro pricing aur free limits final karne hain (market test).

- Accounts P2 me chahiye ya P3 me?

- Ads rakhne hain ya sirf Pro revenue?

- Pehle Hindi launch ke saath ya baad me?

- E-invoice (EU) tools rakhne hain ya India GST invoice par focus?

- Team size aur timeline?

17.3 Next deliverables

- Wireframes (HTML) for Home, Tool workspace, Result, Editor.

- Field-level spec for each tool (validations, i18n strings).

- Drizzle schema, API contracts, worker API spec.

- Design tokens file (Tailwind config) aur component library plan.

- SEO content plan: 100 tool pages + 50 blog topics.
