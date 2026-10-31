# 10 · Features (LIVE inventory)

Single source of truth for "what exists". Registry: `src/lib/tools/registry.ts`
(106 registered — 103 enabled + 3 AI deferred, brace-aware verified). Categories: 9.

## Tool categories & coverage

| Category | Examples (live) |
|----------|-----------------|
| organize | merge, split, rearrange, organize, remove, extract, n-up, halve, assemble, bookmark |
| edit | edit-pdf (text+F&R, crop, page-size, page numbers), annotate, watermark, stamp, overlay, compare |
| convert-to | word/ppt/excel/odt/rtf/publisher/html/markdown/epub→pdf, images→pdf, txt2pdf |
| convert-from | pdf→word/ppt/excel/html/markdown/odt/svg/jpg/webp/tiff, extract images/text |
| security | lock, unlock, protect-flatten, redact, sign (e-sign), digital-signature (P12/PKCS#7), verify-signatures, request-signature (envelopes, :3032) |
| optimize | compress, to-size, resize-kb, web-optimize, pdf-to-pdfa |
| create | create-pdf, resume, card, collage, invoice (visual), electronic-invoice (UBL/CII + Factur-X attach), fillable forms, passport-photo, qr, photo-collage |
| invoices | xml-invoice→pdf, validate e-invoice, pdf→e-invoice, create/extract family |
| view | view, outline, metadata, viewer-preferences, search, scan (+OCR en/hi) — translate/summarize/chat-with-pdf DEFERRED (R23) |

Families flagged `ai: true` (chat/summarize/translate) call `/api/*` →
LLM skill backend-only; files stay device-side, only extracted text goes up.

**R23 — AI features DEFERRED (owner decision, 2025-10-30: "abhi nahi dena,
future plan")**: the three AI-dependent tools (`chat-with-pdf`,
`summarize-pdf`, `translate-pdf`) are `enabled: false` (phase P3) — NOT
offered on the site until the AI backend goes live in a future phase.
The R22 warning UI (banner + chips) was removed with the deferral.
Retained for the future re-enable: registry `aiDependent: true` flags +
`AI_DEPENDENT_TOOLS` export, API routes (honest 503 `aiNotConfigured`),
full tool implementations. Sitemap auto-drops the 3 URLs; live count =
97/100 (About page shows the split). Re-enable plan: 08-PLAN §Deferred.

## Platform features (beyond tools)

- **App:** Ctrl+K search, All-Tools + category pages, favorites (local),
  recent tools, related-tools rail, dark/light, EN/हिंदी toggle.
- **i18n URL-wins (R24):** `/hi` mirrors ALWAYS render Hindi — a stored
  conflicting "en" preference gets a session-only override (never
  clobbered); one header/footer switch restores EN. EN app stays
  preference-driven. hreflang + link-graph + `<html lang>` stay honest.
- **SEO:** 116-URL dynamic sitemap, robots, JSON-LD (SoftwareApplication,
  FAQPage, Breadcrumb, Organization, WebSite SearchAction), OG/Twitter
  cards, canonical + hreflang en/hi, branded bilingual 404.
- **PWA:** installable manifest + offline shell (`public/offline.html`).
- **Auth (optional user feature):** email/password accounts — R25 shipped
  the full frontend (AuthModal login/signup with i18n error mapping,
  header AccountMenu with plan badge, mobile-sheet account section,
  session bootstrap). **R26 shipped /account** (profile card, plan &
  billing with cancel flow, billing history, password change, self-delete
  danger zone) + PricingModal v2 (Free vs Pro comparison, monthly/yearly
  toggle, INR + USD) + `/api/billing/*` stub APIs (checkout honest
  `billingNotConfigured` 503 until providers are configured;
  `BILLING_DEMO=1` sandbox mode completes the full activation) + bottom-tab
  Account tab. Admin panel
  (announcements, bug reports, contact, feedback, tool requests, audit log).
- **Accounting console (R27, admin-only `/accounting`):** double-entry
  books for the business — journal with expandable rows + balanced
  manual-entry dialog, seeded chart of accounts with live balances, GST
  tax invoices (CGST+SGST/IGST split, USD exports), sync sweep
  (payments → books, accrual recognition, refund reversals — idempotent),
  reports (trial balance, P&L, balance sheet, GST summary) + CSV exports.
  EN/हिंदी, entry via account menu / account page (admins only).
- **Feedback loop:** feedback modal, bug reports, tool requests + votes.
- **Admin console (R29, `/admin` owner-only, 8 tabs):** overview stats +
  top tools + recent signups, users (search/ban/unban/role/delete with
  self-guard), bug triage, contact-message inbox (new/read/done), feedback
  totals, **analytics (R42)**, audit log, settings (registration toggle,
  announcements, per-tool enable overrides). Single admin: Deepak Kumar
  (araj.dkg@gmail.com).
- **First-party analytics (R42):** privacy-first PageView beacon (no IP,
  no raw UA, no cross-site id — anonymous visitorId, coarse device class,
  referrer buckets) + admin Analytics dashboard (30-day series, top pages,
  traffic sources, devices, locales, tool health from UsageEvent). GA4
  consent-gated via `NEXT_PUBLIC_GA_ID` (owner sets on Vercel).
- **Image→PDF fill mode + branding (R44):** "Image fit" option
  (`fitMode`) on images-to-pdf + every imagegrid preset (jpg/png/webp/
  heic/tiff/svg) — contain (default) or fill. Fill = cover-crop via a
  page-space clip (`re W n`) ahead of the image cm chain, so A4 pages with
  9:16 phone photos lose their 12–24% blank side bands while the ORIGINAL
  image bytes still embed untouched (crop = clip, never a re-encode).
  Create-side outputs brand watermark-free (owner rule): PDF metadata
  (Producer/Creator "DocoPDF", Title = original base, CreationDate) +
  `-docopdf` output-name suffix — rolled across the whole create family
  (imagegrid, txt/markdown/create/write-pdf, card, collage, passport,
  scan, ocr, translate, invoice; ocr's StampContext route uses
  `setInfo`). Page numbers now use light ink on the dark background.
- **Privacy beacons:** UsageEvent/AnonUsage aggregates + PageView — all
  metadata-only, no file content ever.
- **Mini-services:** convert (office/webpage→pdf), request-sign envelopes.

## Out of scope until Phase 10/11

Real payment provider wiring (Razorpay/Stripe keys — checkout honestly
503s until then), server file storage, multi-user shared envelopes history,
LibreOffice formats (`services/worker/`). The billing SURFACE (plan checks,
pricing modal, account plan management) is live as of R26.
