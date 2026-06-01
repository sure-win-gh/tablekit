# Spec: Marketing campaigns (Plus tier)

**Status:** draft — Phase 3 of the Automation & Engagement plan.
**Depends on:** `messaging.md`, `whatsapp.md`, `message-customisation.md`, `guests.md`, `docs/playbooks/gdpr.md`, `docs/playbooks/payments.md`

## What we're building

Operator-authored **broadcast** messages (special events, offers) sent to a targeted, consented guest list across email / SMS / WhatsApp. Built as a guest-scoped queue **beside** the existing booking-scoped transactional engine — reusing the same provider send functions, retry/backoff, and the Phase-2 merge-tag editor — so everything stays on one platform and the guest list never leaves Tablekit. Marketing rests on **consent (Art. 6(1)(a))**, unlike transactional (contract), so every send is hard-gated on a per-channel marketing-consent timestamp. A Plus-tier feature; SMS/WhatsApp sends are metered and billed pass-through at cost.

## Why this is a Plus feature

Marketing broadcast is a clear upsell (campaign composer, audience targeting, engagement reporting) and carries pass-through send cost. Gated with `requirePlan(orgId, 'plus')`, mirroring the AI enquiry handler.

## User stories

- As a manager (Plus) I create a campaign: pick a venue + channel, write copy with merge tags, and see how many consented guests it will reach and the estimated cost before sending.
- I send now or schedule for later.
- A guest only receives it if they opted in to that channel for that venue and haven't unsubscribed / hard-bounced / been erased.
- I see delivered / opened / clicked counts per campaign.

## Data model

Two new org-scoped tables (forward-only migration; RLS + enforce-org trigger in the same migration):

```sql
create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  venue_id        uuid not null references venues(id) on delete cascade,
  name            text not null,
  channel         text not null check (channel in ('email','sms','whatsapp')),
  status          text not null default 'draft'
                    check (status in ('draft','scheduled','sending','sent','cancelled')),
  subject         text,                 -- email only
  body            text not null,        -- operator copy w/ merge tags (not guest PII)
  scheduled_at    timestamptz,
  sent_at         timestamptz,
  counts          jsonb not null default '{}'::jsonb,  -- {queued,sent,delivered,failed,opened,clicked}
  created_by_user_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table campaign_sends (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  guest_id        uuid not null references guests(id) on delete cascade,
  venue_id        uuid not null references venues(id) on delete cascade,
  channel         text not null,
  status          text not null default 'queued',   -- queued|sending|sent|delivered|bounced|failed
  provider_id     text,
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  opened_at       timestamptz,
  clicked_at      timestamptz,
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (campaign_id, guest_id, channel)         -- idempotent fan-out
);
-- worker partial index on next_attempt_at where status in ('queued','sending')
```

Also: a `message_usage` ledger `(organisation_id, period 'yyyy-mm', channel, count, est_cost_pence)` incremented at successful send in BOTH the transactional and campaign dispatchers (first usage-metering in the codebase; Stripe usage reporting is a later phase — record now).

## API surface

- `lib/campaigns/recipients.ts` — resolve a campaign's audience: consented (`marketing_consent_<channel>_at` not null), not per-venue unsubscribed, not channel-invalid, not erased, has the channel's contact. Returns guest ids + a count (for the pre-send estimate) and an estimated cost.
- `lib/campaigns/enqueue.ts` — create the campaign + fan out `campaign_sends` rows (idempotent on `(campaign,guest,channel)`).
- `lib/campaigns/dispatch.ts` — claim worker (mirrors `messages` `FOR UPDATE SKIP LOCKED`), decrypts recipient, renders via `lib/campaigns/render.ts` (marketing merge tags + branded email layout + unsubscribe footer / STOP line), sends via the shared `sendEmail`/`sendSms`/`sendWhatsApp`, reuses `backoffMs`/`truncateError`, increments `message_usage`. **Re-checks consent + suppression + erasure at send time** (belt-and-braces beyond the enqueue-time filter).
- `lib/campaigns/usage.ts` — `recordUsage(orgId, channel)`.
- `app/api/cron/campaign-tick/route.ts` — drains scheduled/queued campaign_sends (Bearer `CRON_SECRET`); added to `vercel.json`. Send-now also drives the worker inline.
- `app/(dashboard)/dashboard/venues/[venueId]/campaigns/*` + actions — list/create/send, gated `requireRole('manager')` + `requirePlan(orgId,'plus')`; reuses the Phase-2 merge-tag editor + preview; pre-send recipient count + cost estimate.
- Engagement: extend `app/api/resend/webhook/route.ts` for `email.opened` / `email.clicked` → stamp `campaign_sends.opened_at` / `clicked_at` (look up by provider id) + bump campaign `counts`.

## Acceptance criteria

- [ ] A campaign only enqueues + sends to guests with the channel's marketing consent; unconsented / unsubscribed / invalid / erased guests are excluded at BOTH enqueue and send.
- [ ] Fan-out is idempotent: re-running enqueue for a campaign never double-sends `(campaign,guest,channel)`.
- [ ] Pre-send screen shows the consent-filtered recipient count + estimated pass-through cost.
- [ ] Email overrides/copy render with merge tags + the unsubscribe footer; SMS/WhatsApp carry the STOP line. Operator can't strip the opt-out.
- [ ] `requirePlan('plus')` blocks Core/Free on every campaign route + action.
- [ ] Engagement: Resend opened/clicked events update the send row + campaign counts.
- [ ] `campaigns`, `campaign_sends`, `message_usage` ship RLS + a cross-tenant isolation test.
- [ ] DSAR erasure scrubs a guest's `campaign_sends` (drops engagement rows / guest linkage); dispatch gates on `erased_at`.
- [ ] Usage recorded in `message_usage` at each successful send.

## Out of scope

- Audience **segmentation** (RFM, lapsed, VIP) + the segment-driven **automations** (win-back, birthday) — Phase 4, which owns the segment engine. v1 audience is "all consented guests for the venue + channel" (optionally narrowed by a simple visited-since filter).
- Stripe metered-billing reporting of `message_usage` — later phase (record now).
- A/B testing, link-level click analytics beyond Resend's, deliverability dashboards.
- WhatsApp marketing template pre-approval workflow (operator supplies an approved template for marketing categories; freeform only inside the 24h window).
