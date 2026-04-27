# Spec: Reviews & reputation management

**Status:** draft (Phase 1 — shipped: capture + Google redirect; Phase 2 — operator dashboard + reply)
**Depends on:** `bookings.md`, `messaging.md`

## What we're building

Phase 1 of a reputation management feature. After a booking moves to `finished`, the guest receives an email asking for feedback. They land on a public TableKit page (HMAC-tokenised URL), submit a 1-5 star rating + optional comment, and are then offered a deep link to the venue's Google review form alongside a "send private feedback" path.

Future phases (Stampede-parity): operator review dashboard, Google Business Profile pull, TripAdvisor / Facebook ingestion, AI sentiment + reply drafts, escalation alerts, public review showcase. Tracked separately.

## Compliance — review gating

Google's policy ([support.google.com/contributionpolicy/answer/7400114](https://support.google.com/contributionpolicy/answer/7400114)) bans soliciting reviews only from likely-positive customers. The flow therefore **always** offers the Google link after submission, regardless of rating. Copy can de-emphasise it on low ratings (lead with "we'd love to make it right") but never hide it.

## Data model

```sql
create table reviews (
  id           uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,                -- denormalised from booking
  venue_id     uuid not null,                   -- denormalised from booking
  booking_id   uuid not null unique references bookings(id) on delete cascade,
  guest_id     uuid not null references guests(id) on delete cascade,
  rating       smallint not null check (rating between 1 and 5),
  comment_cipher text,                          -- envelope-encrypted PII
  source       text not null default 'internal' check (source in ('internal','google','tripadvisor','facebook')),
  redirected_to_external boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
```

- `BEFORE INSERT` trigger copies `organisation_id` and `venue_id` from the parent booking (matches the `enforce_messages_org_id` pattern).
- RLS: SELECT for authenticated members where `venue_id IN (SELECT public.user_visible_venue_ids())` (per-venue scoping, matches `bookings_member_read`). No INSERT/UPDATE/DELETE policies — writes go through `adminDb()`.
- `comment` is encrypted via `lib/security/crypto.ts` like other PII.

## Messaging

New template `booking.review_request` (email-only in Phase 1) — registered in `lib/messaging/registry.ts` and added to the `messages_template_check` constraint. Enqueued by `onBookingFinished()` at `now + reviewRequestDelayHours` (default 24h, configurable per venue).

Email contains a primary CTA (rate publicly) and a secondary link (private feedback). Both deep-link to the public submission page with an HMAC-signed token.

## Token

`signReviewToken({ bookingId })` → `?p=<base64url(bookingId)>&s=<HMAC-SHA256>`. Pattern mirrors `lib/messaging/tokens.ts` (unsubscribe). No expiry — guests open old emails for years; idempotency on `reviews.booking_id` prevents replay damage.

## Settings (per venue)

Stored in `venues.settings` JSONB:

- `reviewRequestEnabled: boolean` (default `true`)
- `reviewRequestDelayHours: number` (24 / 48 / 72 — default `24`)
- `googlePlaceId: string | null` (default `null`)

If `googlePlaceId` is unset, the post-submission screen shows only "Done" (no Google link).

## Acceptance criteria

- [ ] `finished` booking → `messages` row created at `+reviewRequestDelayHours` (gated on toggle).
- [ ] Idempotent: second `finished` → `confirmed` → `finished` cycle doesn't double-enqueue.
- [ ] Token URL renders the public page; tampered tokens 404.
- [ ] Submit creates one `reviews` row; second submit with same token updates the existing row (unique on `booking_id`).
- [ ] RLS: org-A members cannot see org-B reviews.
- [ ] Comment is encrypted at rest (`comment_cipher` is base64-shaped, never plaintext in DB).
- [ ] Google deep link uses `https://search.google.com/local/writereview?placeid=<placeId>` only when `googlePlaceId` is set.
- [ ] Operator can toggle the feature off and adjust delay in the venue settings page.

## Phase 2 — Operator dashboard + reply

`/dashboard/venues/[venueId]/reviews` lists submitted reviews with stats header (avg rating, reply rate, last 7 days), rating + replied filters, and an inline reply form per row. The reply text is encrypted into `reviews.response_cipher` and emailed to the guest via a new `review.operator_reply` template (one-shot per review — editing lands later). Three new columns added: `response_cipher`, `responded_at`, `responded_by_user_id`. CHECK constraint enforces consistency (cipher set iff timestamp set).

## Out of scope (next phases)

- Google Business Profile / TripAdvisor / Facebook ingestion.
- AI sentiment + reply drafting.
- Negative-review escalation alerts.
- Public review showcase widget.
- SMS channel for review requests.
- Multi-dimensional ratings (food/service/value/atmosphere).
