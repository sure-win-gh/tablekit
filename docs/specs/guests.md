# Spec: Guest profiles, CRM basics, consent

**Status:** shipped
**Depends on:** `auth.md`. See `docs/playbooks/gdpr.md` for data protection requirements.

## What we're building

A minimal guest CRM: profiles, visit history, tags, allergy/preference notes, marketing consent.

## Important

The operator (venue) is the **data controller** for guest data. We are the **data processor**. This shapes everything below. Read `docs/playbooks/gdpr.md` before starting.

## User stories

- As a host I can look up a returning guest by name/phone/email.
- As a manager I can tag a guest (VIP, allergy:nuts, loud-party, etc.).
- As a guest making a booking I can opt in to marketing from this specific venue.
- As a guest I can request erasure of my data (forwarded to the operator via a DSAR inbox).

## Data model

```sql
create table guests (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  email_hash       bytea,           -- sha256(lower(email) || org_salt)
  email_cipher     bytea,           -- envelope-encrypted plaintext
  phone_hash       bytea,
  phone_cipher     bytea,
  first_name       text,
  last_name_cipher bytea,           -- encrypted
  dob_cipher       bytea,
  tags             text[] not null default '{}',
  notes_cipher     bytea,
  marketing_consent_email_at timestamptz,
  marketing_consent_sms_at   timestamptz,
  created_at       timestamptz not null default now(),
  last_visit_at    timestamptz
);

create index on guests (organisation_id, email_hash);
create index on guests (organisation_id, phone_hash);
```

## Acceptance criteria

- [x] `lib/security/crypto.ts` provides envelope encryption — `encryptPii(orgId, plaintext)` / `decryptPii(orgId, ciphertext)` ([`lib/security/crypto.ts`](../../lib/security/crypto.ts)). DEK per org wrapped by `TABLEKIT_MASTER_KEY`; `organisations.wrapped_dek` + `dek_version` columns hold the wrap.
- [x] Plaintext last name / phone / DoB never logged. Enforced by the `PreToolUse` PII guard hook (claude-code session config) + the convention that all writes flow through `encryptPii(...)` before hitting the schema's `*Cipher` columns. The dashboard never serialises raw PII into error responses — server actions return typed `Result<T, E>` discriminated unions with neutral messages.
- [x] Email displayable to the owning org only. Stored encrypted at rest in `guests.email_cipher`; decrypted in-memory inside dashboard server components before render. RLS scopes the row to org members; cross-org leaks blocked by the same policy that scopes every tenant table.
- [x] Guest search uses `email_hash` / `phone_hash` — no plaintext scans. [`lib/guests/upsert.ts`](../../lib/guests/upsert.ts) + [`lib/guests/update-contact.ts`](../../lib/guests/update-contact.ts) call `hashForLookup(input.email, "email")` (HMAC-SHA256 under the master key) and query `guests.email_hash` directly.
- [x] Marketing consent unticked by default, timestamped on tick, per-channel. Schema has nullable `marketing_consent_email_at` + `marketing_consent_sms_at` timestamps ([`lib/db/schema.ts`](../../lib/db/schema.ts)) — null means no consent; tick stamps `now()`.
- [x] Erasure via dashboard button + `audit_log`. The privacy-requests dashboard creates a DSAR row of type `erase`; [`lib/dsar/scrub.ts`](../../lib/dsar/scrub.ts) nulls + re-encrypts placeholder PII inside one transaction and writes `dsar.scrubbed` / `guest.erased` audit entries.
- [x] Erasure SLA: 30 days. [`lib/dsar/create.ts`](../../lib/dsar/create.ts) — `SLA_DAYS = 30`; `due_at` stamped at row creation; sweep cron at `/api/cron/dsar-scrub` drives bulk scrubs; dashboard kicks an inline scrub so an operator's flow doesn't wait for the cron.
- [x] Guest data org-scoped + group-CRM opt-in. RLS verified by [`tests/integration/rls-guests.test.ts`](../../tests/integration/rls-guests.test.ts) and the per-venue variant [`rls-guests-per-venue.test.ts`](../../tests/integration/rls-guests-per-venue.test.ts). Cross-venue aggregation is gated on `organisations.group_crm_enabled` (Plus-tier owner toggle).

## Out of scope

- Automatic guest deduplication across organisations.
- Importing guest lists from incumbents (see `import-export.md`).
