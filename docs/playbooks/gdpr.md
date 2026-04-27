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

Outbound hyperlinks to third-party sites (e.g. the Google review form linked from `/review`) are **not** sub-processing — the guest navigates their own browser to the third party; no PII is transmitted from TableKit.

## Lawful basis

- **Booking a table:** contract (Art 6(1)(b)). We don't need consent to store a booking the guest is creating.
- **Marketing email/SMS:** consent (Art 6(1)(a)). Opt-in only, per-channel, per-venue.
- **Post-visit review request:** legitimate interests (Art 6(1)(f)) within the PECR reg 22(3) soft-opt-in carve-out for service follow-up. A single, non-promotional email asking the guest to rate the visit they just had, sent through the same per-venue email channel as transactional confirmations and honouring the same unsubscribe. **LIA:** balancing test favours the venue's interest in service improvement against the guest's reasonable expectation that a recent visit may generate a follow-up. Not used for promotion or third-party sharing. The per-venue email-channel unsubscribe is authoritative for review requests too.
- **Fraud prevention, abuse monitoring:** legitimate interests (Art 6(1)(f)). Documented in our ROPA.
- **Legal/accounting retention:** legal obligation (Art 6(1)(c)).

## Data categories and retention

| Category              | Retention                      | Erasure on request? |
|-----------------------|--------------------------------|---------------------|
| Booking history       | 7 years (UK accounting)        | Pseudonymised after org erasure request |
| Guest contact details | Until guest or org erases      | Yes, 30 days |
| Marketing preferences | Until opt-out                  | Yes, immediately on opt-out |
| Review text (free-form comment) | 24 months from submission (rating retained indefinitely as numeric only) | Yes, immediately on guest erasure |
| Payment metadata (Stripe IDs, no PAN) | 7 years     | Stripe IDs retained, PII decoupled |
| Audit log             | 2 years                        | No (integrity) |
| Session logs          | 30 days                        | Auto-expiry |

## DSAR workflow (Data Subject Access / Erasure Requests)

Guests don't contact us directly — they contact the venue. The venue uses the dashboard to action requests.

1. Operator opens guest profile → "Data rights" menu.
2. Options: export (JSON+CSV), rectify, erase.
3. Erasure: flips `guests.erased_at`, schedules background job to scrub PII columns within 30 days, writes `audit_log` entry.
4. Erased guests: `email_cipher`, `phone_cipher`, `last_name_cipher`, `dob_cipher`, `notes_cipher` nulled. `first_name` overwritten to "Erased". `reviews.comment_cipher` for that guest's reviews is also nulled (rating kept as numeric — not personal data on its own). Bookings pseudonymised (kept for accounting) — no way to link back.
5. A `dsar_requests` table logs requests with 30-day SLA clock.

We also expose a guest-facing page at `/privacy/request?v=<venue-slug>` that posts to the operator's dashboard as a DSAR ticket.

## Encryption

- **At rest:** Postgres TDE via Supabase (AES-256).
- **Column-level for PII:** envelope encryption. `lib/security/crypto.ts` is the only module that touches plaintext or the wrapped DEK.
  - Each organisation owns a random 32-byte **DEK** stored on `organisations.wrapped_dek`, sealed with the **master key** using AES-256-GCM (format: `iv(12) || tag(16) || ciphertext(32)` = 60 bytes).
  - PII columns are encrypted with the DEK using AES-256-GCM (12-byte random IV, 16-byte auth tag). Ciphertext is stored as a versioned string: `v1:<iv_b64>:<ct_b64>:<tag_b64>`.
  - DEKs are provisioned lazily: the first `encryptPii(orgId, …)` call for an org generates, wraps, and persists. No pre-seed step.
  - Process-level DEK cache (cleared on restart) avoids a per-row unwrap.
- **Master key:** today `TABLEKIT_MASTER_KEY` env var (32 bytes, base64). Production hardening migrates to Supabase Vault / KMS — the public API of `lib/security/crypto.ts` is stable across the swap. A rotation invalidates every wrapped DEK and every `hashForLookup` value, so treat it as a data-migration event.
- **Lookup hashing:** `hashForLookup(input, kind)` is HMAC-SHA256 under the master key, hex-encoded. `kind="email"` lowercases + trims; `kind="phone"` strips non-digits. Used for `(org_id, email_hash)` uniqueness on guests and "find-by-email" without decrypting rows.
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
6. For features that capture free-text from guests (review comments, DSAR messages, booking notes): add a privacy notice on the input surface, cap input length at the smallest defensible value, and ensure the erasure job covers the encrypted column.
