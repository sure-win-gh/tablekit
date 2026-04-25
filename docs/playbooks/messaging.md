# Playbook: Transactional messaging

**Audience:** Claude Code and the operator.
**Read before:** touching anything in `lib/messaging/*`, `lib/email/*`, `lib/sms/*`, or the `/api/resend/webhook` + `/api/twilio/webhook` routes.

## Architecture in one diagram

```
                                                                ┌───────────────────────┐
booking transition → onBookingConfirmed/Cancelled/Finished ──→ │ enqueueMessage        │
(create.ts / transition.ts / payment-intent-succeeded.ts /     │ (insert ON CONFLICT   │
 setup-intent-succeeded.ts)                                    │  DO NOTHING)          │
                                                                └──────────┬────────────┘
                                                                           │
                                                                           ▼
                                                                ┌───────────────────────┐
inline drives (triggers.ts after enqueue,                       │ messages table        │
 dashboard/bookings page load,                                  │ (status=queued, +     │
 POST /api/v1/bookings,                                         │  next_attempt_at)     │
 daily cron /api/cron/deposit-janitor)                          └──────────┬────────────┘
                                                                           │
                                                                           ▼
                                                                ┌───────────────────────┐
                                                                │ processNextBatch      │
                                                                │  - claim FOR UPDATE   │
                                                                │    SKIP LOCKED        │
                                                                │  - load-context       │
                                                                │  - render             │
                                                                │  - send               │
                                                                │  - retry/fail/mark    │
                                                                └──────────┬────────────┘
                                                                           │
                                       ┌───────────────────────────────────┴───────────────────────────────┐
                                       ▼                                                                   ▼
                              Resend (email)                                                    Twilio (SMS)
                                       │                                                                   │
                              email.delivered/                                            MessageStatus=delivered/
                              email.bounced/email.complained                              failed/undelivered
                                       │                                                                   │
                                       ▼                                                                   ▼
                            POST /api/resend/webhook                                       POST /api/twilio/webhook
                            (Svix signature)                                               (validateRequest)
```

## Provider setup

### Resend

1. **DPA in place** before sending production traffic — Resend offers an EU-region option; pick it.
2. Verify your sending domain (DKIM + SPF). Without verification, Resend hard-bounces validation errors and our send classifier marks them non-retryable.
3. Webhook endpoint: `https://app.tablekit.test/api/resend/webhook`. Subscribe to `email.delivered`, `email.bounced`, `email.complained` at minimum.
4. Save the `whsec_…` signing secret to `RESEND_WEBHOOK_SECRET`. Rotate quarterly + on any suspected leak.
5. Set `RESEND_FROM_EMAIL` to `Brand <no-reply@yourdomain>` — the brand prefix is what shows in inboxes.

### Twilio

1. UK long code or short code (long code = cheaper, slower throughput). Add to `TWILIO_FROM_NUMBER`.
2. **Auto-response keywords:** Twilio handles STOP/HELP at the carrier level by default; we still surface `STOP` etc. in our webhook handler so operators can see the action in the audit log.
3. Status callback URL: `https://app.tablekit.test/api/twilio/webhook`. Twilio signs requests with HMAC-SHA1; we use the SDK's `validateRequest()`.
4. Inbound messaging URL: same path. The handler branches on payload shape (`Body+From` = inbound, `MessageSid+MessageStatus` = status).
5. `TWILIO_AUTH_TOKEN` rotation: change in Twilio Console → update `.env` → restart serverless functions. Old signed callbacks in flight will fail signature check until they expire.

## Idempotency + retries

- `messages` has a unique index on `(booking_id, template, channel)` — re-enqueueing the same template for the same booking is a silent no-op.
- The dispatch worker claims via `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` — concurrent workers can't double-claim.
- Send-side idempotency: Resend gets an `Idempotency-Key` header (`msg_<row-id>_v1`) so a retry inside Resend's 24h dedupe window collapses. Twilio doesn't have an equivalent, so the unique-claim is the primary defence.
- Backoff schedule (post-claim attempts → delay): 1m → 5m → 15m → 1h → fail. Spec says 5 attempts max.
- Stuck-in-sending recovery: rows whose `updated_at` exceeds 5 minutes are reclaimed on the next worker tick. The duplicate-send risk inside that window is bounded by Resend's idempotency key (email) and Twilio's per-tenant rate limits (SMS).

## Replaying a stuck send

1. `SELECT id, status, attempts, error FROM messages WHERE status IN ('queued','sending') AND updated_at < now() - interval '1 hour';`
2. If a row is genuinely stuck, set `status='queued'` + `next_attempt_at=now()`. The next worker run picks it up.
3. If a row is `failed`, decide: was it a genuinely permanent failure (bad email, 21000-range Twilio code) or a transient one we mis-classified? If transient, re-queue with `attempts=0`.

## Killing all sends in an incident

```
MESSAGING_DISABLED=true
```

- Both `lib/email/send.ts` and `lib/sms/send.ts` short-circuit with a non-retryable error.
- The dispatch worker marks affected rows `failed` with reason `messaging-disabled`, then continues.
- Re-enable + replay via the queue procedure above.

## Per-venue unsubscribe

- Token format: `?p=<base64url(guestId.venueId.channel)>&s=<hmac-sha256>`
- Signed with the master key (same as `hashForLookup`); verifier is `lib/messaging/tokens.ts#verifyUnsubscribe`.
- Unsubscribe page (`/unsubscribe`) idempotently appends the venue id to `guests.email_unsubscribed_venues` (or `sms_unsubscribed_venues`).
- `loadMessageContext` short-circuits with `reason='missing-recipient'` when the guest has unsubscribed from the venue's channel — the dispatch worker marks the row failed without sending.
- Tokens never expire by design (Gmail re-processes old emails for years). Master-key rotation is the only mechanism to invalidate a leaked token.

## GDPR considerations

- DSAR erase: unsubscribe state lives on `guests` and is wiped with the rest of the row when erased.
- 2-year retention applies to `messages.error` text. Don't log full HTML bodies — only template name + provider id.
- Bounce / complaint events flag the underlying contact (`email_invalid` / `phone_invalid`) — these are GLOBAL across venues, since the email/phone itself is broken. Per-venue opt-out lives in the array columns.

## Pre-launch checklist

- [ ] Resend DPA signed; sending domain verified; webhook endpoint live + receiving events.
- [ ] Twilio long code provisioned; webhook URL configured for inbound + status callbacks; `validateRequest` working in staging.
- [ ] `MESSAGING_DISABLED` toggle tested end-to-end on staging — kill switch fires, stays off, recovers cleanly.
- [ ] At least one full booking lifecycle dry-run: confirmation → 24h reminder → 2h reminder → finished → thank-you. All six rows visible in `messages`, all status='delivered'.
- [ ] Cookie banner / privacy notice references both Resend + Twilio in the sub-processor list.
- [ ] An operator has clicked their own venue's unsubscribe link end-to-end and confirmed they no longer receive that template.
