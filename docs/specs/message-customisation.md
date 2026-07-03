# Spec: Message customisation (content & flow control)

**Status:** shipped (PR #70) — Phase 2 of the Automation & Engagement plan. UI restructured into tabs (2026-07-02).
**Depends on:** `messaging.md`, `whatsapp.md`, `guests.md`, `docs/playbooks/gdpr.md`

## What we're building

Operator control over the lifecycle messages guests receive: **flow** (whether each message sends, on which channel, and with what timing) and **content** (per-venue branding + editable copy via safe merge tags). Today every template is hardcoded (only `venueName` varies), timings are fixed except the review-request delay, and channels come from the code-level registry. This adds a per-venue config overlay the existing renderers and triggers consult — defaults stay the shipped templates, so a venue that customises nothing is unaffected. This is also what turns on the Phase 1 WhatsApp channel: operators opt a venue into WhatsApp here.

## User stories

- As an operator I switch a lifecycle message (e.g. the 2-hour reminder) on or off.
- As an operator I choose the channel order for each message — e.g. "WhatsApp, then SMS, then email" — and the guest gets the first channel they're reachable + opted-in on.
- As an operator I retime reminders / thank-you within sensible bounds.
- As an operator I set my venue's branding (logo, accent colour, reply-to, signature) and edit each message's copy using merge tags, with a live preview — without being able to break the unsubscribe footer or STOP line.

## Data model

No new tenant table for flow — it lives in the existing `venues.settings` JSONB under a typed `messaging` key, parsed by `lib/messaging/venue-settings.ts`. Branding lives alongside it (`settings.branding`).

Per-template **content** overrides get their own table (forward-only migration, RLS in the same migration):

```sql
create table message_templates (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  venue_id        uuid not null references venues(id) on delete cascade,
  template        text not null,           -- MessageTemplate
  channel         text not null,           -- 'email' | 'sms' | 'whatsapp'
  subject_override text,                    -- email only
  body_override   text,
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (venue_id, template, channel)
);
-- RLS: organisation_id in (select user_organisation_ids()); org_id
-- synced from the parent venue by a before-insert trigger (messages pattern).
```

## API surface

- `lib/messaging/venue-settings.ts` — Zod schema + `parseMessagingSettings(venue.settings)` returning a fully-defaulted, typed object (per-event `enabled` / `channels` / timing, within whitelisted bounds). Single source of truth replacing the scattered inline `as Record<string, unknown>` reads.
- `lib/messaging/resolve-channels.ts` — replace the Phase-1 stub with the real resolver: `resolveChannels({ template, settings, guest })` = registry capability ∩ operator-enabled channels (in preference order) ∩ guest opt-out/invalid/valid-contact, returning the first deliverable channel (not every capable one). Triggers load venue settings + guest suppression flags and pass them in.
- `lib/messaging/triggers.ts` — read per-event timing from settings instead of the hardcoded 24h/2h/3h literals; enqueue the resolved channel.
- `lib/messaging/templates/render.ts` (or extend the registry) — apply a per-(venue, template, channel) override when present, interpolating a **fixed merge-tag set** (`{{guestFirstName}}`, `{{venueName}}`, `{{startAtLocal}}`, `{{partySize}}`, `{{reference}}`, `{{serviceName}}`) with a safe substituter (no arbitrary HTML/script; unknown tags error in preview, render literal at send).
- Branding threaded into `MessageBookingContext` + consumed by `lib/email/templates/_layout.tsx`.
- Settings UI (2026-07 restructure): `settings/messaging/page.tsx` is a three-tab surface — **Messages** (one expandable row per lifecycle message: enable toggle, channel order, timing, AND the copy override + merge tags + live preview, saved together by the per-event `saveMessage` action so a row's save can never clobber a sibling message), **Branding** (venue-level fields, own `updateBranding` action), **Usage & costs** (org-scoped current-month `message_usage` read via RLS). Row headers show at-a-glance state: on/off dot, timing, channel chain, Custom-copy badge. Locked elements (unsubscribe footer, STOP line) remain non-removable; the old page-wide `updateMessagingSettings` action and the standalone composer were retired in the restructure.

## Acceptance criteria

- [ ] `parseMessagingSettings` applies defaults (current behaviour: confirmation email-on, reminders on, etc.) and rejects out-of-bound timings; a venue with empty settings behaves exactly as today.
- [ ] `resolveChannels` returns the first deliverable channel by operator preference, skipping opted-out / invalid / no-contact channels; WhatsApp only enqueues when the operator enabled it for that message AND the guest has a phone.
- [ ] Disabling a message stops it being enqueued; retiming changes the schedule; both honour the retroactive-schedule guard.
- [ ] A copy override renders with merge tags substituted; the unsubscribe footer + STOP line are always appended and cannot be removed; preview rejects unknown tags.
- [ ] Branding (logo/colour/reply-to/signature) appears in emails; absent branding falls back to the shipped layout.
- [ ] `message_templates` ships with an RLS policy + a cross-tenant isolation test (tenant A cannot read tenant B's overrides).
- [ ] DSAR/erasure unaffected (no guest PII in `message_templates` — operator copy only; document that operators must not paste guest data, mirroring `bookings.notes`).
- [ ] Existing transactional behaviour for un-customised venues is unchanged (regression test).

## Out of scope

- Marketing/broadcast campaigns + automations — Phase 3 (reuses this phase's merge-tag editor).
- A visual drag-and-drop journey builder — explicitly a non-goal for year 1.
- Per-guest channel preference (operator-set venue preference only).
- Localisation of operator-authored copy beyond the venue `locale` already applied to dates/times.
