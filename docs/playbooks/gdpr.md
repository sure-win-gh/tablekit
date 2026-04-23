# Playbook: GDPR & data protection

**Audience:** Claude Code, the solo operator, and any future contributor.
**Read before:** touching anything in `guests.md`, `messaging.md`, or anything that stores personal data.

## The one-line summary

We are a **data processor**. The venue (organisation) is the **data controller** for their guests. This dictates every design choice around guest data.

## What this means in practice

- Guest data is owned by the organisation, not by us. We store it, we process it on their instruction, we don't use it for our own purposes.
- We have a signed **Data Processing Agreement (DPA)** with every organisation. The DPA is in the signup flow (click-through) and a countersigned PDF is available on request.
- We maintain a **sub-processor list** at `/legal/sub-processors` and notify organisations 30 days before adding a new one.
- We don't cross-use data between organisations. Even within the same group, venues are siloed unless the operator enables group-wide CRM (Plus tier, opt-in).

## Current sub-processors (keep this updated)

| Sub-processor | Purpose                | Region      | DPA signed |
|---------------|------------------------|-------------|------------|
| Supabase      | Database, auth, storage| EU (Frankfurt or London) | Yes |
| Vercel        | App hosting, edge      | EU regions forced | Yes |
| Stripe        | Payments               | EU (Ireland) | Yes |
| Resend        | Transactional email    | EU          | Yes |
| Twilio        | SMS                    | EU (Ireland) | Yes |
| Sentry        | Error tracking         | EU          | Yes |
| Cloudflare    | DNS, WAF, edge cache   | Global (no PII routed) | Yes |

Any new sub-processor requires: DPA signed, EU data residency confirmed, entry added to this table and to `/legal/sub-processors`, and 30-day notice to existing customers.

## Lawful basis

- **Booking a table:** contract (Art 6(1)(b)). We don't need consent to store a booking the guest is creating.
- **Marketing email/SMS:** consent (Art 6(1)(a)). Opt-in only, per-channel, per-venue.
- **Fraud prevention, abuse monitoring:** legitimate interests (Art 6(1)(f)). Documented in our ROPA.
- **Legal/accounting retention:** legal obligation (Art 6(1)(c)).

## Data categories and retention

| Category              | Retention                      | Erasure on request? |
|-----------------------|--------------------------------|---------------------|
| Booking history       | 7 years (UK accounting)        | Pseudonymised after org erasure request |
| Guest contact details | Until guest or org erases      | Yes, 30 days |
| Marketing preferences | Until opt-out                  | Yes, immediately on opt-out |
| Payment metadata (Stripe IDs, no PAN) | 7 years     | Stripe IDs retained, PII decoupled |
| Audit log             | 2 years                        | No (integrity) |
| Session logs          | 30 days                        | Auto-expiry |

## DSAR workflow (Data Subject Access / Erasure Requests)

Guests don't contact us directly — they contact the venue. The venue uses the dashboard to action requests.

1. Operator opens guest profile → "Data rights" menu.
2. Options: export (JSON+CSV), rectify, erase.
3. Erasure: flips `guests.erased_at`, schedules background job to scrub PII columns within 30 days, writes `audit_log` entry.
4. Erased guests: `email_cipher`, `phone_cipher`, `last_name_cipher`, `dob_cipher`, `notes_cipher` nulled. `first_name` overwritten to "Erased". Bookings pseudonymised (kept for accounting) — no way to link back.
5. A `dsar_requests` table logs requests with 30-day SLA clock.

We also expose a guest-facing page at `/privacy/request?v=<venue-slug>` that posts to the operator's dashboard as a DSAR ticket.

## Encryption

- **At rest:** Postgres TDE via Supabase (AES-256).
- **Column-level for PII:** envelope encryption. Per-org data key wrapped by a master key in Supabase Vault. `lib/security/crypto.ts` is the only module that touches plaintext.
- **In transit:** TLS 1.3 everywhere. HSTS preload on dashboard and widget origins.
- **Backups:** encrypted, region-locked. 30-day point-in-time recovery via Supabase.

## Logs and error tracking

- Sentry EU region only.
- **PII scrubbing:** `beforeSend` hook strips `email`, `phone`, `last_name`, `dob`, `notes` keys from event payloads. Tested in `tests/security/sentry-scrub.test.ts`.
- App logs: no PII. Use `booking.id`, `guest.id`, never plaintext identifiers.
- Access logs exclude query strings and request bodies by default.

## Breach response

If we suspect a personal data breach:

1. Declare a P0 incident (see `incident.md`).
2. Within **24 hours**: internal assessment — scope, categories, rough count, risk to data subjects.
3. Within **72 hours** of awareness: notify ICO if risk to rights/freedoms is non-negligible.
4. Notify affected organisations (controllers) without undue delay — they may need to notify their guests.
5. Document everything in `incidents/` repo.

Do not delete logs or evidence during response, even if doing so seems to "clean up." Preserve, isolate, investigate.

## Things Claude Code must never do

- Log plaintext guest PII (email, phone, name, DoB, notes).
- Return plaintext guest PII in API responses crossing organisation boundaries.
- Copy guest data from one organisation to another, even if asked.
- Add a new sub-processor without updating this playbook and `/legal/sub-processors`.
- Disable RLS, even "temporarily for debugging."
- Store guest data in cookies or client-side storage beyond a booking reference.
- Send marketing messages without checking the relevant per-channel consent timestamp.

## Reviewing changes that touch PII

Before merging any PR that adds or modifies a column, table, or query involving guest data:

1. Run the `gdpr-auditor` subagent (`/audit gdpr`).
2. Confirm encryption is applied to new PII columns.
3. Confirm RLS policy exists and scopes by `organisation_id`.
4. Confirm retention and erasure behaviour covers the new column.
5. Update this playbook if a new data category is introduced.
