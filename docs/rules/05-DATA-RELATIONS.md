# 05 · Data Relations (Prisma)

Schema: [`prisma/schema.prisma`](../../prisma/schema.prisma) — mirrors
PRD §2.5 table names exactly (`@@map`), so the Turso/libSQL swap needs no
renames. Sandbox: SQLite (`db/`, `DATABASE_URL`). Production plan: Turso.

## HARD RULE

**Metadata only.** NEVER store PDF content, file bytes, or user file names
in any table/column — not even "temporarily". Files live on the user's
device (OPFS/IndexedDB) or in request-sign's ephemeral envelope store
(disk-capped, auto-expiring) — never in the DB.

## Models & relations

```
User  1─n  Session            (userId, cascade delete; reserved for OAuth —
                             web sessions are stateless JWT, zero rows today)
User  1─n  Subscription      (provider razorpay|stripe, plan, periodEnd)
User  1─n  Payment           (amount in minor units, currency INR default)
User  1─n? BugReport         (optional userId → SetNull)
ToolRequest  1─n  RequestVote (composite PK requestId+voterHash, cascade)
```

Standalone tables (no FK): `AnonUsage` (PK anonId+toolId+day),
`UsageEvent` (toolId,mode,success,durationMs,sizeBucket,locale,day),
`Feedback`, `ContactMessage`, `BlogPost` (PK slug+locale), `Job`,
`AuditLog`, `SiteSetting` (PK key).

## Conventions

- IDs: uuid strings (`@default(uuid())`), not autoincrement — Turso-ready.
- Money: integer minor units (paise). Never floats.
- Enums are `String` with documented values (`plan: free|pro`,
  `role: user|admin`, `mode: D|S`, `status: new|open|…`).
- Indexes: every FK + every hot query path (`toolId+day`, `status`).
- Soft delete: `deletedAt` on User; hard deletes cascade from User only.
- Privacy: `AnonUsage.anonId` and `RequestVote.voterHash` are salted
  hashes, never raw identifiers.

## Workflow

1. Edit `prisma/schema.prisma` → `bun run db:push` (sandbox).
2. Document any new table in this file the same commit.
3. Production swap (Turso): keep names identical; auth/DB code must keep
   graceful degradation when `DATABASE_URL` is absent (R19 contract).
