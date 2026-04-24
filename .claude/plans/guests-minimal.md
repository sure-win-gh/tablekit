# Phase: `guests-minimal` — the one table bookings needs

## Why this is a separate phase

Bookings reference guests. The full guests surface (DSAR tooling, right-to-erasure scrub job, guest-facing privacy page, marketing consent UI, search/filter UI in the dashboard, deduplication merge flow) is big enough that bundling it with bookings creates a reviewer-hostile PR. This phase ships **just the schema + the upsert server action** so the bookings phase can say `guest_id uuid references guests(id)` and move on.

Everything else is noted under "out of scope" and gets its own phase (`guests-dsar`, `guests-ui`, etc.) closer to launch.

## Architectural decisions (already taken)

| # | Decision |
|---|---|
| G1 | Guests are **org-scoped, not venue-scoped**. A guest who books at two of an operator's venues is one row; the bookings table carries `venue_id`. |
| G2 | **First name stored in plaintext** — it's the biggest readability win in the dashboard and the lowest-sensitivity PII field. Last name, email, phone, DoB (later), notes (later) are encrypted. Matches gdpr.md §Erasure — which renames `first_name` to "Erased" on DSAR rather than decrypting-and-blanking. |
| G3 | Per-column pattern: `<field>_cipher text` for encrypted value + `<field>_hash text` for the deterministic HMAC lookup (email only for now; phone hash added in a follow-up when guest-search UI arrives). |
| G4 | Dedup key: `unique(organisation_id, email_hash)`. Upsert reuses silently — the audit log records the match (`guest.reused`) so a manager can reconstruct who booked first. |
| G5 | Denormalised `organisation_id` pattern carries forward: guests already has it natively (no parent trigger needed). |
| G6 | `erased_at timestamptz null` — plumbed now so bookings can `where erased_at is null`. The scrub job that actually clears cipher columns is deferred to `guests-dsar`. |
| G7 | RLS: `member_read` for authenticated, no direct insert. Writes go through a server action in `lib/guests/actions.ts` that runs under `withUser` (for read-back) + `adminDb` (for the encrypted write that must bypass RLS on insert — matches the pattern in `lib/server/admin/`). |
| G8 | Server action returns a typed Result — `{ ok: true, guestId }` or `{ ok: false, reason }`. No throwing at the action boundary. |

## Deliverables

1. `guests` table in `lib/db/schema.ts` + migration `0003_*.sql` with RLS.
2. `lib/guests/upsert.ts` — `upsertGuest(orgId, input): Promise<Result>` that encrypts, hashes, and upserts.
3. Zod schema for the input (email valid, phone optional, first/last name length caps).
4. Unit tests for the pure parts (Zod validation, normalisation).
5. Integration test: cross-tenant RLS, and upsert dedup behaviour.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Add `guests` table to schema. Columns: id, organisationId, firstName, lastNameCipher, emailCipher, emailHash, phoneCipher (null), marketingConsentAt (null), erasedAt (null), createdAt, updatedAt. | `lib/db/schema.ts` |
| 2 | Generate + apply migration 0003. Add `unique(organisation_id, email_hash)` index. Write RLS policies (member_read only; no insert/update/delete policies for authenticated — writes go via service_role). | `drizzle/migrations/`, hand-write the policies block |
| 3 | Zod input schema in `lib/guests/schema.ts`. | `lib/guests/schema.ts` |
| 4 | `upsertGuest` implementation in `lib/guests/upsert.ts` — uses `encryptPii` + `hashForLookup("email", …)`, inserts via `adminDb`, handles unique-constraint conflict by updating the existing row's optional fields where the caller provided a new non-null value. | `lib/guests/upsert.ts` |
| 5 | Audit hooks: `guest.created` and `guest.reused` log entries. | — |
| 6 | Unit tests: Zod boundary cases (empty name, bad email), normalisation sanity. | `tests/unit/guests-schema.test.ts` |
| 7 | Integration test: `tests/integration/rls-guests.test.ts` — cross-tenant invisibility, upsert dedup returns same id, second upsert with new phone updates the existing row. | `tests/integration/` |
| 8 | `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` all green. | — |
| 9 | Commit: `feat(guests): minimal guests table + upsert action`. | — |

## Out of scope (deferred to their own phases)

- `guests-dsar` — DSAR request table, erasure scrub job, guest-facing privacy page, 30-day SLA clock.
- `guests-ui` — dashboard list / search / profile view, merge-candidate flow, phone-hash add.
- `guests-marketing` — marketing consent capture UI, suppression list, Resend audience sync.
- DoB, notes columns — added when the feature requesting them lands.
- Phone uniqueness / phone hash index — deferred until we actually need "find guest by phone."

## Success criteria

- `upsertGuest(orgA, { firstName:"Jane", lastName:"Doe", email:"jane@x.com" })` returns a guest id. Calling again with the same email returns the same id.
- `upsertGuest(orgA, { email:"jane@x.com", phone:"..." })` updates the existing row's phone cipher/hash, does not create a duplicate.
- RLS denies user B from seeing org A's guests.
- Calling as the authenticated role to `insert into guests` directly fails (no insert policy).
- All existing tests still pass.
