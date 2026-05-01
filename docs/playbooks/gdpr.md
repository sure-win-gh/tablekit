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
| Google (Business Profile API) | Pulling reviews, posting operator replies, and reading the operator's GBP account + location list for the picker UI | Global (review data is already public; OAuth tokens stored encrypted in TableKit) | Yes — Google's standard data-processing terms apply |

Any new sub-processor requires: DPA signed, EU data residency confirmed, entry added to this table and to `/legal/sub-processors`, and 30-day notice to existing customers.

Outbound hyperlinks to third-party sites (e.g. the Google review form linked from `/review`) are **not** sub-processing — the guest navigates their own browser to the third party; no PII is transmitted from TableKit.

## Lawful basis

- **Booking a table:** contract (Art 6(1)(b)). We don't need consent to store a booking the guest is creating.
- **Marketing email/SMS:** consent (Art 6(1)(a)). Opt-in only, per-channel, per-venue.
- **Post-visit review request:** legitimate interests (Art 6(1)(f)) within the PECR reg 22(3) soft-opt-in carve-out for service follow-up. A single, non-promotional email asking the guest to rate the visit they just had, sent through the same per-venue email channel as transactional confirmations and honouring the same unsubscribe. **LIA:** balancing test favours the venue's interest in service improvement against the guest's reasonable expectation that a recent visit may generate a follow-up. Not used for promotion or third-party sharing. The per-venue email-channel unsubscribe is authoritative for review requests too.
- **Operator reply to a guest review:** legitimate interests (Art 6(1)(f)) within PECR reg 22(3). A single, non-promotional reply within the same service-follow-up loop the guest opted into when they submitted the review. Honours the same per-venue email unsubscribe as the review request (enforced at `lib/messaging/load-context.ts` before any decrypt). **LIA:** the guest's reasonable expectation after submitting a star rating + comment includes a reply from the venue; the venue's interest in service recovery and reputation outweighs the minimal further intrusion. Not used for promotion or third-party sharing.
- **Operator reply to an external (Google) review:** controller-to-controller between the venue and Google — TableKit is processor for the venue, transmitting the reply via the Business Profile API for publication under the existing public review thread. No new personal data of the reviewer is created or stored by us beyond what was already imported. Reply text stored locally is encrypted (`reviews.response_cipher`) and falls under the same retention rule as other review text. We do not need separate consent because the reviewer chose to publish on Google; the reply is the venue's response to a public statement, not a new outbound to the data subject.
- **Operator escalation alert email (low-rating reviews):** legitimate interests (Art 6(1)(f)). Recipient is the operator (manager or org owner), not the data subject; the alert exists so the operator can respond to a complaint they were already going to read in the dashboard. Email body includes rating, source, optional reviewer display name, and a 280-char snippet of the comment — no new processing purpose beyond what the operator already has dashboard access to. **LIA:** the operator's interest in timely service recovery outweighs the marginal further intrusion of receiving the alert by email rather than seeing it on next dashboard load. Recipient resolution: `venue.settings.escalationEmail` if set, otherwise the org's first owner by membership creation time (deterministic fallback). Operators can disable on the settings page; the alert email's unsubscribe URL points there. The escalation alert email sets `oneClickUnsubscribe: false` because the URL is a settings deep-link, not a POST handler.
- **Recovery offer email to guest (operator-initiated):** legitimate interests (Art 6(1)(f)) within PECR reg 22(3). A single, non-promotional, operator-authored note sent through the same per-venue email channel as transactional confirmations, honouring the same per-venue email unsubscribe (enforced at `lib/messaging/load-context.ts` before any decrypt). **LIA:** distinct from the Phase 2 operator reply only in trigger (operator-initiated rather than auto-triggered by submission); the guest has just submitted feedback and a follow-up offer of resolution sits within their reasonable expectation, especially at 1–3 stars. Not used for promotion. The guest can withdraw at any time by unsubscribing the venue's email channel.
- **Fraud prevention, abuse monitoring:** legitimate interests (Art 6(1)(f)). Documented in our ROPA.
- **Legal/accounting retention:** legal obligation (Art 6(1)(c)).

## Data categories and retention

| Category              | Retention                      | Erasure on request? |
|-----------------------|--------------------------------|---------------------|
| Booking history       | 7 years (UK accounting)        | Pseudonymised after org erasure request |
| Guest contact details | Until guest or org erases      | Yes, 30 days |
| Marketing preferences | Until opt-out                  | Yes, immediately on opt-out |
| Internal review text (guest comment + operator reply on TableKit) | 24 months from submission/reply (rating retained indefinitely as numeric only) | Yes, immediately on guest erasure |
| Recovery offer message (operator → guest) | 24 months from offer (alongside `comment_cipher`) | Yes, immediately on guest erasure |
| Showcase consent record (`showcase_consent_at`) | Same as parent review (24 months from submission) | Nulled on guest erasure |
| Escalation alert timestamp (`escalation_alert_at`) | Lifetime of the review row — non-PII metadata only | No (no PII) |
| Imported review (external source — Google etc.) | Synced from source while connection active; row deleted within 30 days of disconnect; not retained after disconnect | Imported reviews are not linked to our `guests` table — see §DSAR for the carve-out |
| Reviewer display name (external) | Same as the imported review row | Same as the imported review row |
| OAuth tokens (provider connection) | Until operator disconnects or revokes upstream; deleted on disconnect | Yes — disconnect deletes the row |
| Payment metadata (Stripe IDs, no PAN) | 7 years     | Stripe IDs retained, PII decoupled |
| Audit log             | 2 years                        | No (integrity) |
| Session logs          | 30 days                        | Auto-expiry |
| Import job records (`import_jobs`: filename, column_map, counters) | 12 months from `completed_at` / `failed_at` | No PII fields by design — purged by cron |
| Imported guest provenance (`guests.imported_from`, `imported_at`) | Lifetime of the guest row | Nulled on guest erasure (see §DSAR step 4) |
| Inline source CSV (`import_jobs.source_csv_cipher`) | Envelope-encrypted at column level. Nulled on `completed_at`; nulled by cron 7 days after `failed_at` regardless of retry status; nulled by cron 7 days after `created_at` for jobs still in `preview_ready` (abandoned uploads); nulled on parent row delete | Yes — nulled on guest erasure for any linked job (writer must record the linkage) |
| Imported job filename (`import_jobs.filename`) | Plaintext, capped 200 chars, path-stripped at the upload boundary. Best-effort non-PII but operators may name files `guests-jane@example.com.csv`. Nulled on guest erasure for any linked job and on parent row delete. Never forwarded to audit log payloads or Sentry | Yes — nulled on guest erasure (treat as PII to be safe) |
| Rejected-rows artefacts (signed download from `import_jobs.rejected_rows_url`) | Object lives in private Supabase Storage bucket; signed URL ≤ 24h; object purged on parent `import_jobs` row delete | Yes — deletion of the parent row purges the object |

## DSAR workflow (Data Subject Access / Erasure Requests)

Guests don't contact us directly — they contact the venue. The venue uses the dashboard to action requests.

1. Operator opens guest profile → "Data rights" menu.
2. Options: export (JSON+CSV), rectify, erase. The export must include any internal reviews the guest left or that were left on their bookings: `rating`, decrypted `comment`, decrypted operator `response`, `submittedAt`, `respondedAt`. Imported external reviews are out of scope (no deterministic guest mapping — see step 4). (Pipeline TBD — track as part of the DSAR builder phase.)
3. Erasure: flips `guests.erased_at`, schedules background job to scrub PII columns within 30 days, writes `audit_log` entry.
4. Erased guests: `email_cipher`, `phone_cipher`, `last_name_cipher`, `dob_cipher`, `notes_cipher` nulled. `first_name` overwritten to "Erased". Provenance columns `imported_from` and `imported_at` are also nulled — both are linkable metadata that would otherwise reveal the guest had been migrated from a specific named platform. For every review the guest left, the scrub also nulls: `reviews.comment_cipher`; `reviews.response_cipher` + `reviews.responded_at` + `reviews.responded_by_user_id` (cleared together to keep `reviews_response_consistency_check`); `reviews.recovery_message_cipher` + `reviews.recovery_offer_at` + `reviews.recovery_offered_by_user_id` (cleared together to keep `reviews_recovery_consistency_check`); `reviews.showcase_consent_at` (consent record no longer references a living data subject). Rating is kept as numeric only — not personal data on its own; operator attribution is dropped to leave no path back to the data subject. Dispatch worker also gates on `guests.erased_at` at `lib/messaging/load-context.ts` so any in-flight queued messages for an erased guest are marked failed before render. Bookings pseudonymised (kept for accounting) — no way to link back.
   - **Imported reviews from external sources (Google etc.) are not scrubbed on guest erasure.** The source identifies the reviewer by public display name only and we have no deterministic mapping from `guests.id` to a Google reviewer. The source platform remains the controller of the public review; the row will re-import on the next sync regardless of any local action. Guests who want a Google review removed must request it from Google directly. We document this on `/privacy/request` and the operator's DSAR action UI surfaces it as a non-actionable line.
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
- Log or send to Sentry a `RejectedRow` or any raw imported CSV row — those payloads carry plaintext PII keyed by operator-chosen headers that `beforeSend` does not scrub. Log only counts and the `import_jobs.id` for correlation.
- Persist a raw uploaded CSV in a non-encrypted column. The bytes contain plaintext guest email/name/phone — encrypt at column level via `lib/security/crypto.ts:encryptPii` (the `import_jobs.source_csv_cipher` pattern), or place the blob in a private Supabase Storage bucket with the same retention as `rejected_rows_url`. Supabase TDE alone is the at-rest layer, not a column-level guarantee.
- Log or persist a raw uploaded CSV filename in audit log payloads or Sentry events — operator-chosen filenames may embed guest PII (e.g. `guests-jane@example.com.csv`). Use the `import_jobs.id` as the durable handle and keep `metadata.filename` out of `audit.log()` calls.

## Reviewing changes that touch PII

Before merging any PR that adds or modifies a column, table, or query involving guest data:

1. Run the `gdpr-auditor` subagent (`/audit gdpr`).
2. Confirm encryption is applied to new PII columns.
3. Confirm RLS policy exists and scopes by `organisation_id`.
4. Confirm retention and erasure behaviour covers the new column.
5. Update this playbook if a new data category is introduced.
6. For features that capture free-text from guests (review comments, DSAR messages, booking notes): add a privacy notice on the input surface, cap input length at the smallest defensible value, and ensure the erasure job covers the encrypted column.
7. For features that publish guest data on a public surface (showcase widget, hosted booking page, etc.): consent must be unticked-by-default, per-channel, timestamped, and accompanied by a withdrawal mechanism that is at least as easy as the giving (Art 7(3)). The product must surface the withdrawal control before launch — a "contact the venue" promise is only adequate when paired with a documented operator-side runbook that can action the takedown promptly. The consent surface itself must link to the privacy notice covering the publication.
