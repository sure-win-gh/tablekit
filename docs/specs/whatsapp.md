# Spec: WhatsApp transactional channel

**Status:** shipped (PR #70) — Phase 1 of the Automation & Engagement plan. Dormant until enabled per-venue; Meta non-EU sub-processor (SCCs/TRA + 30-day notice) is a go-live gate before first real send.
**Depends on:** `messaging.md`, `guests.md`, `docs/playbooks/gdpr.md`

## What we're building

WhatsApp as a third delivery channel for the existing lifecycle messages, alongside email and SMS. WhatsApp is materially cheaper than SMS for the same reach. It plugs into the existing queue/dispatch engine as a new `MessageChannel`, with its own provider send path, per-channel consent/opt-out, and delivery webhooks. Transactional WhatsApp is a Core+ paid channel (like SMS); operators turn it on per venue. Which lifecycle messages actually use WhatsApp is decided by the Phase 2 flow resolver — this spec only adds the channel.

## Why a channel, not a rebuild

The registry + dispatch worker are channel-agnostic by design: `templateChannels()` already drives what gets enqueued, and `renderForChannel()` dispatches by channel. WhatsApp is additive — a new provider module mirroring `lib/sms/`, one new arm in the registry, one new branch in the dispatcher, and per-channel suppression columns on `guests`.

> **Sub-processor note (GDPR).** Routing messages through WhatsApp means guest phone numbers + message content reach **Meta's global (US) infrastructure**, even when fronted by Twilio. Every other PII sub-processor in `gdpr.md` is EU-resident; this is a deliberate exception. Meta must be added to the sub-processor table (Global, under SCCs), `/legal/sub-processors` updated, and existing customers given 30 days' notice before first production egress — same process as the AWS Bedrock precedent.

## User stories

- As an operator I enable WhatsApp for my venue in settings (Core+), having confirmed I accept the Meta data-transfer notice.
- As a guest I receive my booking confirmation / reminder on WhatsApp instead of (or in addition to) SMS. I can opt out of a specific venue's WhatsApp via the unsubscribe link, or reply STOP — which Twilio honours globally for that sender — to stop all WhatsApp from us.
- As an operator my WhatsApp business-initiated messages use Meta-approved message templates so they deliver outside the 24-hour session window.

## Data model

New columns on `guests` (forward-only migration; mirror the existing email/SMS pair):

```sql
alter table guests
  add column whatsapp_invalid boolean not null default false,
  add column whatsapp_unsubscribed_venues uuid[] not null default array[]::uuid[],
  add column marketing_consent_whatsapp_at timestamptz;
```

- The WhatsApp number reuses the existing encrypted `phone_cipher` — no separate number column in v1.
- `messages.channel` CHECK constraint widened to include `'whatsapp'` (new migration).
- The Meta-approved template SID mapping (our template → Twilio Content SID + variables) lives in config, not the DB, in v1.

## API surface

- `lib/whatsapp/client.ts` + `lib/whatsapp/send.ts` — `sendWhatsApp(input): Promise<{ providerId }>`, throwing `WhatsAppSendError` with a `retryable` flag (same shape as `SmsSendError`). Reuses the Twilio SDK with `whatsapp:` address prefixes and the shared `MESSAGING_DISABLED` kill switch.
- `lib/whatsapp/templates/*.ts` — plain-string renderers (like SMS), returning the approved-template reference + variables for business-initiated sends.
- `lib/messaging/registry.ts` — `"whatsapp"` added to `MessageChannel`, a `whatsapp?` slot on `RegistryEntry`, and `whatsapp` arms in `templateChannels()` + `renderForChannel()`.
- `lib/messaging/dispatch.ts` — a `rendered.kind === "whatsapp"` branch calling `sendWhatsApp`.
- `lib/messaging/load-context.ts` — a `whatsapp` arm in the per-channel suppression block (mirrors the SMS arm: `whatsapp_invalid`, `whatsapp_unsubscribed_venues`, missing `phone_cipher`).
- `app/api/twilio/whatsapp/route.ts` — Twilio status-callback + inbound webhook: signature-verified; status events flip `messages.status` (delivered/failed) and set `whatsapp_invalid` on hard failure; inbound `STOP` adds the venue to `whatsapp_unsubscribed_venues`. Mirrors `app/api/resend/webhook/route.ts`; PII-safe error handling per `gdpr.md`.
- New env: `TWILIO_WHATSAPP_FROM` (documented in `.env.local.example`).

## Acceptance criteria

- [ ] `sendWhatsApp` sends via Twilio WhatsApp and returns the provider SID; `WhatsAppSendError.retryable` matches the SMS classification so `dispatch.ts` retry/backoff is unchanged.
- [ ] Registry resolves `whatsapp` renderers; `templateChannels()` includes `whatsapp` where a renderer exists.
- [ ] Dispatch sends a `whatsapp` message end-to-end and records `provider_id`.
- [ ] Suppression honoured: an opted-out (`whatsapp_unsubscribed_venues`), hard-invalid (`whatsapp_invalid`), erased, or phone-less guest is never sent a WhatsApp.
- [ ] Per-venue opt-out is applied via the signed unsubscribe link (writes `whatsapp_unsubscribed_venues`). A STOP reply is acknowledged and enforced globally per-sender by Twilio's opt-out cache (we have no venue context on a raw inbound, and no `phone_hash` on guests to match the row — a future phase adds `phone_hash` to also flip `whatsapp_invalid` on the matched guest).
- [ ] Outbound sends set a `statusCallback`; the status webhook updates `messages.status` (delivered/bounced) and sets `whatsapp_invalid` (not `phone_invalid`) on permanent WhatsApp failure.
- [ ] Business-initiated sends reference a Meta-approved template; the 24h-session constraint is documented in code.
- [ ] DSAR scrub nulls the new `whatsapp_*` columns on guest erasure (`lib/dsar/scrub.ts` + test).
- [ ] `gdpr.md` sub-processor table + `/legal/sub-processors` updated with Meta; 30-day customer notice recorded before first production egress.
- [ ] Per-venue WhatsApp enablement gated Core+ at the settings toggle.

## Out of scope

- Choosing *which* lifecycle messages use WhatsApp and channel-preference ordering — that's Phase 2 (flow control).
- Marketing/broadcast over WhatsApp — Phase 3.
- Meta Cloud API direct integration (cheaper per-message) — revisit after volume justifies a second provider.
- Inbound WhatsApp conversations / two-way chat beyond STOP handling.
- A distinct WhatsApp number separate from the booking phone number.
