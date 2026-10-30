# 01 · PRD Rules (Product Requirements)

**Canonical PRD:** [`docs/PRD-v2.md`](../PRD-v2.md) (v2.0, owner-approved).
Everything below is the distilled, binding subset. If PRD and this file
disagree, PRD wins and this file gets fixed.

## Vision

One place for every PDF job (merge, split, compress, edit, sign, convert,
OCR, secure, invoice) — no signup required, fast, private. Range of PDF24,
flow of iLovePDF, editor better than PDFSimpli. English + Hindi (India-first).

## Personas (build for them, in order)

1. **Anon mobile user** (majority) — one-shot task, 3 steps max, zero
   friction, works on 3G + cheap Android.
2. **Power desktop user** — editor, organize, digital signature, batch.
3. **SMB/enterprise (later)** — request-signature envelopes, accounts, Pro.

## Hard product rules (from PRD §hard-rules)

- **Privacy is the product.** Mode-D (device-only) tools upload nothing.
  Server tools (Mode S) exist only where a browser cannot do the job
  (webpage→PDF, fetch-page) and must say so in the UI.
- **No signup wall for core tools.** Accounts are for Pro/history only.
- **Free tier stays genuinely usable** (PRD §pricing); Pro gates only
  batch/heavy features.
- **Hindi is first-class**, not a translation afterthought — locale toggle,
  localized SEO, localized errors.
- **Legal:** licenses of every vendored library recorded in `NOTICE`/`LICENSE`
  files next to the vendored assets; no AGPL/GPL dependencies (house rule).
- Legal/pricing copy needs owner (lawyer) sign-off before launch claims.

## Acceptance mindset

A tool is "done" only when: registered + enabled, i18n en/hi parity,
smoke battery green, E2E golden path verified, mobile 390px clean,
Hindi view clean. See `14-TESTING.md`.

## PRD section map (frequently cited)

| PRD § | Topic |
|-------|-------|
| §2.5 | Database tables (mirrored in `prisma/schema.prisma`) |
| §7 | Tool categories (9) |
| §9 | Static pages (about/contact/privacy/terms) |
| §14 | Security: CSP, headers, device-only modes |
