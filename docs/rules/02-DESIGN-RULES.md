# 02 · Design Rules (UI/UX)

Stack: **Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons + Framer
Motion**. Brand: DocoPDF custom tokens (see `src/app/globals.css`).

## Non-negotiables

1. **shadcn/ui first.** `src/components/ui/*` primitives before any custom
   component; DocoPDF wrappers live in `src/components/doco/`
   (SiteHeader, SiteFooter, Modal, BottomSheet, EmptyState, ThemeToggle,
   LanguageSwitch…).
2. **No raw hex/indigo/blue.** Use Tailwind variables
   (`bg-background`, `text-foreground`, `bg-primary`…). Brand palette comes
   from tokens; dark mode must look designed, not inverted.
3. **Responsive is mandatory.** Mobile-first; breakpoints `sm:/md:/lg:`.
   Touch targets ≥ 44px. Every new screen is QA'd at 390px (mobile) AND
   desktop — the E2E round checks both (see `14-TESTING.md`).
4. **Sticky footer.** Root layout uses `min-h-screen flex flex-col`;
   footer gets `mt-auto`. Short page → footer hugs viewport bottom;
   long page → footer is pushed naturally, never overlays content.
   Respect iOS safe-area insets.
5. **Semantic HTML + ARIA.** `main/header/nav/section/article`; every
   icon-only control gets an `aria-label` (a11y smoke enforces names);
   `sr-only` for screen-reader text; alt text on all images; full
   keyboard navigability.
6. **Long lists scroll, don't grow forever.** `max-h-96 overflow-y-auto`
   + custom scrollbar styling.
7. **Loading / error / empty states.** Skeletons or spinners for async;
   actionable error text; EmptyState component for zero-data. Toasts
   (sonner) for user feedback.
8. **i18n UX.** No hardcoded strings — `t("key")` from `src/i18n`.
   Locale-aware plurals: ONLY `=N` + `other` (ICU `one {}` renders tofu).
   Devanagari must render with self-hosted Noto Sans Devanagari
   (tofu regression is part of every E2E).

## Motion & feel

- Framer Motion for hover/focus/page transitions — subtle (150–250ms).
- Respect `prefers-reduced-motion`.
- Hover/active feedback on every clickable element.

## ToolShell UX contract

- Every tool renders through the shared ToolShell (config-driven from
  `tools/<id>/config.ts`): picker → options → processing → result.
- 3-step flow max for one-shot tools; keep the DropZone + magic-byte
  validation UX consistent.
- Result page offers: download, "do another", related tools.
- Never block the UI thread — heavy work goes to Web Workers
  (`worker.ts`), canvas ops follow `tools/pdfjs-common/worker-lib` patterns.

## Theme

- `next-themes` light/dark; system default; no flash (inline pre-hydration
  script is the one CSP-sanctioned inline script).
- Brand logo/OG assets: `public/logo.svg`, `public/og-image.png`
  (1200×630, sharp-generated via `scripts/gen-og-image.ts`).
