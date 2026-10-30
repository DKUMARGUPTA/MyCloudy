# 06 · API Rules

All server endpoints live in `src/app/api/**` (Next.js route handlers) or
the two mini-services. Client always calls **relative** URLs only
(`fetch("/api/...")`) — cross-port calls use `?XTransformPort=<port>` in the
QUERY STRING, never a port in the hostname (gateway rule; see
`13-INTEGRATIONS.md`).

## Route inventory (stable as of R19)

| Route | Auth | Notes |
|-------|------|-------|
| `/api/auth/*` | public | signup/login/logout/me (sidocs session JWT) |
| `/api/admin/*` | **gateAdmin** | admin panel actions; AuditLog writes |
| `/api/announcements` | public | site announcements |
| `/api/bug-reports` | public + rate limit | files BugReport rows |
| `/api/chat` | public + rate limit | chat-with-pdf (LLM skill, backend only) |
| `/api/contact` | public + rate limit | ContactMessage |
| `/api/feedback` | public + rate limit | inline limiter pattern |
| `/api/fetch-page` | public | Mode-S page fetch **with SSRF guard** (reference implementation, `route.ts:124-141,223`) |
| `/api/summarize` | public + rate limit | summarize-pdf (LLM skill) |
| `/api/translate` | public + rate limit | translate (LLM skill) |
| `/api/tools` | public | registry metadata |
| `/api/usage` | public | beacon (UsageEvent / AnonUsage) |

Mini-services (gateway-proxied, own JSON envelope):
`convert` :3031 · `request-sign` :3032 — hardened per R19 Phase 2.

## Mandatory contracts

1. **JSON error envelope.** Handlers return JSON errors, never the Next.js
   HTML 500 page. Resolution of session/admin MUST sit INSIDE the
   try/catch (use `src/lib/api-auth.ts` `gateUser`/`gateAdmin` — they fold
   failures into `{ error: "server_error" }` 500).
2. **No internal leakage.** Never `String(err)` / stack traces to clients.
   Log server-side with a prefix (`[route] …`), return stable codes:
   `bad_request | invalid_credentials | email_taken | rate_limited |
   weak_password | invalid_email | banned | forbidden | not_found |
   server_error` (client maps to `auth.err.*` i18n keys).
3. **Rate limit every public mutator** with `src/lib/rate-limit.ts`
   (`rateLimit(key, limit, windowMs)` + `clientIp(req)`). Return
   `429` + `retryAfterSec`.
4. **SSRF policy (Mode-S fetches).** Allow-list scheme http/https; DNS
   resolve THEN check every resolved IP; refuse loopback/private/link-local/
   ULA/v4-mapped; pin the resolver for the actual request. Copy the
   pattern from `/api/fetch-page` — do not invent a new one.
5. **Size caps before buffering.** Check `Content-Length` BEFORE
   `req.formData()`/`req.json()` buffers the body; enforce the per-route
   MAX_BYTES; stream or reject early (disk-exhaustion lesson, R19).
6. **Method discipline.** Explicit exports per method; unknown → 405 JSON.
   Validate input with zod or explicit guards before touching the DB.
7. **Metadata only** in responses/rows (see `05-DATA-RELATIONS.md`).

## Mini-service envelopes

Both mini-services answer `{ ok, code?, detail??, data? }` with generic
500s (`convert.failed` / `rsign.*` codes). Their rate limits and caps are
documented in `03-ARCHITECTURE.md`; if you change a limit, update that
table in the same commit.
