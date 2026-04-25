# Spec: Transactional email + SMS

**Status:** shipped — confirmation + 24h reminder + cancelled + thank_you (email) and reminder_2h (SMS) live; waitlist_ready ships with the waitlist phase.
**Depends on:** `bookings.md`

## What we're building

Automated lifecycle messages for every booking: confirmation, 24-hour reminder, 2-hour reminder, thank-you. Email is free and on by default. SMS is a paid add-on (Plus tier or pass-through credits).

## Providers

- Email: **Resend**.
- SMS: **Twilio** (UK short code + long code fallback).

Both have EU data residency options. DPA in place before launch.

## Templates (starter set)

1. `booking.confirmation` — immediately after `confirmed` status.
2. `booking.reminder_24h` — 24 hours before `start_at`.
3. `booking.reminder_2h` — 2 hours before `start_at` (SMS only).
4. `booking.cancelled` — on operator or guest cancellation.
5. `booking.thank_you` — 3 hours after `finished`.
6. `booking.waitlist_ready` — when a waitlisted guest can now be seated.

All templates live in `lib/email/templates/*.tsx` (React Email) and `lib/sms/templates/*.ts` (plain strings).

## Acceptance criteria

- [ ] Messages triggered by a queue (Vercel Cron + Supabase function), not inline in HTTP handlers.
- [ ] Each message is idempotent: unique `(booking_id, template, channel)` row in `messages` table.
- [ ] Failed sends retried with exponential backoff up to 5 attempts.
- [ ] Unsubscribe is **per-venue**, not global. Honour `List-Unsubscribe` header.
- [ ] SMS opt-out via STOP keyword handled.
- [ ] Bounce and complaint events from Resend/Twilio mark the guest's contact as invalid.
- [ ] All template text localised by venue `locale` (default `en-GB`).

## Data model

```sql
create table messages (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  channel    text not null check (channel in ('email','sms')),
  template   text not null,
  status     text not null default 'queued',   -- queued|sent|delivered|bounced|failed
  provider_id text,
  error      text,
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (booking_id, template, channel)
);
```

## Out of scope

- Marketing / broadcast email (Plus tier, later).
- WhatsApp (expensive, revisit year 2).
