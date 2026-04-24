# Phase: `crypto` — envelope encryption primitives

## Why now

`bookings` and `guests-minimal` both need to store encrypted PII (surname, phone, optional DoB). `lib/security/crypto.ts` today is a stub that throws. Rather than open-code encryption inside the bookings server action or leave the stubs live until the last minute, ship the primitives as their own small phase with unit coverage.

Stability target: once merged, the `encryptPii` / `decryptPii` / `hashForLookup` contract does not change. Guests/bookings import these functions and never touch crypto internals.

## Architectural decisions (already taken — `Go with your best recommendation`)

| # | Decision |
|---|---|
| C1 | Scheme: **per-org DEK, wrapped by a process-wide master key** (envelope encryption). Matches `docs/playbooks/gdpr.md §Encryption`. |
| C2 | Master key source: `TABLEKIT_MASTER_KEY` env var (base64, 32 bytes). Migration path to Supabase Vault / KMS is a later production-hardening phase; the API surface is identical. |
| C3 | Data cipher: **AES-256-GCM** (authenticated encryption, 12-byte random IV, 16-byte tag). |
| C4 | Ciphertext format (string): `v1:<iv_b64>:<ct_b64>:<tag_b64>`. Version prefix enables future rotation. |
| C5 | DEK storage: `organisations.wrapped_dek bytea` + `organisations.dek_version int not null default 1`. Nullable `wrapped_dek` for lazy provisioning. |
| C6 | DEK provisioning: **lazy**. `ensureOrgDek(orgId)` is called from inside `encryptPii` / `decryptPii` if the row has no DEK yet. No trigger, no manual backfill. |
| C7 | Lookup hash: **HMAC-SHA256(master, normalise(input))** hex-encoded. Global (not per-org) so cross-org "is this email already a TableKit user?" is possible later, and so the simple `(org_id, email_hash)` uniqueness on guests works cheaply. Input normalisation: lowercase + trim for email; strip non-digits for phone. |
| C8 | Process-level DEK cache: `Map<orgId, Buffer>` to avoid per-row unwrap. Cleared on process restart (good enough — master key can rotate independently). |

## Deliverables

1. `lib/security/crypto.ts` — real implementation replacing the throwing stubs. Public API unchanged:
   - `encryptPii(orgId: string, plaintext: string): Promise<Ciphertext>`
   - `decryptPii(orgId: string, ciphertext: Ciphertext): Promise<string>`
   - `hashForLookup(input: string, kind?: "email" | "phone" | "raw"): string` — kind added; defaults to `"raw"`. Emails/phones normalise before hashing.
2. Drizzle schema: add `wrappedDek` + `dekVersion` to `organisations`.
3. Migration `0002_*.sql`: `alter table organisations add column wrapped_dek bytea, add column dek_version integer not null default 1`. No data migration.
4. `.env.local.example`: add `TABLEKIT_MASTER_KEY` (base64 32 bytes), remove the now-stale `ENCRYPTION_MASTER_KEY_REF` (or keep as forward-looking comment pointing to the Vault migration phase).
5. Unit tests (`tests/unit/crypto.test.ts`):
   - round-trip `encrypt → decrypt` returns original plaintext
   - ciphertext is non-deterministic (different IV each call)
   - tamper detection: flipping a bit in ciphertext → decrypt throws
   - cross-org leak: org A ciphertext cannot be decrypted as org B
   - `hashForLookup` is deterministic per input, different per input
   - `hashForLookup("email", "X@Y.com")` === `hashForLookup("email", "x@y.com")`
6. Docs: update `docs/playbooks/gdpr.md §Encryption` to match the shipped design (move the "pending review" note).

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Add `TABLEKIT_MASTER_KEY` to `.env.local.example`, document how to generate (`openssl rand -base64 32`). Generate a real one for local `.env.local`. | `.env.local.example` |
| 2 | Extend organisations schema with `wrappedDek`/`dekVersion`. | `lib/db/schema.ts` |
| 3 | `pnpm db:generate` → migration `0002_*.sql`. Hand-verify it's additive only. | `drizzle/migrations/` |
| 4 | Apply locally (`pnpm db:migrate`). | — |
| 5 | Implement `lib/security/crypto.ts` (envelope encrypt/decrypt, lazy DEK, lookup hash). | `lib/security/crypto.ts` |
| 6 | Add unit tests (`tests/unit/crypto.test.ts`). | `tests/unit/` |
| 7 | `pnpm typecheck && pnpm lint && pnpm test` green. | — |
| 8 | Update `docs/playbooks/gdpr.md §Encryption` to reflect shipped design. | `docs/playbooks/gdpr.md` |
| 9 | Commit: `feat(crypto): envelope encryption for PII columns`. | — |

## Out of scope (explicitly deferred)

- **Key rotation** — neither master-key rotation nor DEK rotation lands here. `dek_version` is plumbed but only `1` exists. Rotation is a production-hardening phase with its own plan.
- **Supabase Vault / KMS migration** — only the env-var path is wired. Swap is a one-file change in `crypto.ts`.
- **Audit hooks on crypto calls** — no `audit.log` entry per decrypt. If we ever need it, it's a wrap point in `decryptPii`.
- **Per-org master-key escrow / right-to-erasure via DEK destruction** — noted in gdpr.md but implemented in a later phase when we have operator DSAR tooling.

## Success criteria

- `encryptPii(org, "Smith")` round-trips to `"Smith"`.
- Tampering with any byte of the ciphertext causes `decryptPii` to throw (GCM auth tag).
- Two orgs encrypting the same plaintext produce ciphertexts that cannot be swapped.
- `hashForLookup("email", "X@Y.com") === hashForLookup("email", "x@y.com")`.
- All existing tests still pass (we didn't break auth or venues).
