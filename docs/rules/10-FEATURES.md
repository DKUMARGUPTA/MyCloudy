# 10 · Features (LIVE inventory)

Single source of truth for "what exists". Registry: `src/lib/tools/registry.ts`
(100 enabled tools, brace-aware verified). Categories: 9.

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
- **Auth (optional user feature):** email/password accounts, admin panel
  (announcements, bug reports, contact, feedback, tool requests, audit log).
- **Feedback loop:** feedback modal, bug reports, tool requests + votes.
- **Privacy beacons:** UsageEvent/AnonUsage aggregates only (metadata).
- **Mini-services:** convert (office/webpage→pdf), request-sign envelopes.

## Out of scope until Phase 10/11

Pro billing UI, server file storage, multi-user shared envelopes history,
LibreOffice formats (`services/worker/`).
