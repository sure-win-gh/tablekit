# Spec: Guest profiles, CRM basics, consent

**Status:** draft
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

- [ ] `lib/security/crypto.ts` provides `encrypt(plaintext, org_id)` / `decrypt(cipher, org_id)` using envelope encryption (key per org, wrapped by master key in Supabase Vault).
- [ ] Plaintext of last name, phone, DoB never logged, never serialised in errors.
- [ ] Email is displayable to the owning org only. Stored encrypted at rest, decrypted in-memory only when rendering.
- [ ] Guest search uses `email_hash` / `phone_hash` — no plaintext scans.
- [ ] Marketing consent is unticked by default, timestamped on tick, separate flag per channel.
- [ ] A guest can have their record erased via a dashboard button; erasure is logged in `audit_log` with SLA clock started.
- [ ] Erasure SLA: 30 days (GDPR maximum).
- [ ] Guest data scoped by organisation — no cross-venue visibility even within the same group (Plus tier adds an opt-in group-wide CRM).

## Out of scope

- Automatic guest deduplication across organisations.
- Importing guest lists from incumbents (see `import-export.md`).
