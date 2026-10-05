# DocoPDF — services/worker (placeholder)

**Status: NOT BUILT — planned for the final phase (PRD §2.7, §8.6).**

This will be a stateless Docker service (VPS / Fly.io / Railway) that powers
server-assisted (mode "S") tools only:

- Office ↔ PDF conversion (LibreOffice headless)
- Strong PDF compression / linearization (qpdf, pdfcpu)
- PDF/A conversion + validation, ClamAV scanning
- Webpage/HTML → PDF (headless Chromium with SSRF protection)

Hard requirements from the PRD:

- Signed short-lived upload tokens issued by the Vercel API (daily limits checked).
- Direct browser → worker upload (bypasses Vercel's ~4.5 MB body limit).
- Temp files deleted immediately after each job; 5-minute sweeper; max TTL 15 min.
- Sandbox: no network inside job containers, CPU/RAM/time limits.
- Logs contain job id, tool id, size bucket, duration, error code —
  **never file names or content**.

Nothing to run here yet. See the PRD (docs/PRD-v2.md §2.7) for the full flow.
