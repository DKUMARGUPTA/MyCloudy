# 11 · Auth Rules

Implementation: `src/lib/auth.ts` (sidocs session auth, P12) +
`src/lib/api-auth.ts` (route gates). No third-party auth libs (house rule:
`node:crypto` only — no jose/bcryptjs).

## Session design

- **Stateless JWT (HS256)** in httpOnly cookie `sidocs_session`,
  7-day max age. Payload: `{ sub, role, ver, iat, exp }`.
- `AUTH_SECRET` env required; production must fail CLOSED on missing
  secret (500 JSON, never an open session).
- `sessions` table stays reserved for future OAuth — web sessions write
  zero rows (metadata-minimal design).
- **Ban enforcement on every request** (`bannedAt`), **force logout** via
  `tokenVersion` (`ver` claim must match).

## Passwords

- scrypt (N=16384, r=8, p=1, keylen=32, maxmem 64MB), format
  `scrypt$N$r$p$saltB64$keyB64`; `crypto.timingSafeEqual` compare.
- Policy: min length 8, common-pattern guard, `weak_password` code.
- Never log passwords or hashes; never return `passwordHash` in any API.

## Roles & admin

- Roles: `user` (default) | `admin`.
- `ADMIN_EMAILS` auto-claim on login (`araj.dkg@gmail.com` — owner).
- **Every** `/api/admin/*` route MUST use `gateAdmin()`; user routes use
  `gateUser()`. Gates resolve INSIDE the handler's try/catch (JSON 500
  contract, R19 P2-4). Never hand-roll cookie parsing in routes.
- Admin actions that mutate state append an `AuditLog` row
  (`actor`, `action`, `metaJson`).

## Error-code contract (client → i18n `auth.err.*`)

`bad_request | invalid_credentials | email_taken | rate_limited |
weak_password | invalid_email | banned | forbidden | not_found |
server_error`

- 401 = unauthenticated; 403 = authenticated but not allowed / banned;
  429 = rate-limited; 500 = `server_error` only (no internals).

## Abuse defenses

- Auth routes rate-limit per-IP via `src/lib/rate-limit.ts`
  (login/signup stricter than read routes).
- Failed-login responses are deliberately vague (no user-existence leak).
- Delete flows are soft (`deletedAt`) + tokenVersion bump revokes sessions.

## Do / Don't

- ✅ `getSessionUser(request)` / gates; ✅ timingSafeEqual; ✅ httpOnly,
  secure (prod), sameSite=lax cookie flags.
- ❌ localStorage/sessionStorage tokens; ❌ JWT in URLs; ❌ client-side
  role checks without server gate; ❌ new auth packages without house review.
