# Spec: Rich hosted booking page

**Status:** in progress (Phase 1 — shell + profile + Google/internal reviews)
**Depends on:** `widget.md`, `venues.md`, `reviews.md`, `bookings.md`, `plan-gating-paywall.md`

## What we're building

A richer, TheFork-style hosted booking page at `book.tablekit.uk/<venue-slug>` for **Core and Plus** venues: venue profile (description, cuisine, price range, address, contact), an aggregate star rating built from **Google + internal** reviews, a photo gallery, a stylised availability calendar, and a map. Free venues keep today's simple page.

The work ships in four phases (see Roadmap). This spec is the source of truth for all four; Phase 1 is implemented first.

Scope rule: the rich treatment applies to the **hosted `/book` page only**. The `/embed` iframe stays the lean, cookieless, <30 KB compact widget defined in `widget.md` — operators embedding on their own site already control the surrounding page.

## Roadmap

| Phase | Deliverable |
|---|---|
| **1 (shipped)** | Page shell + venue profile (`settings.profile`) + aggregate rating from Google + internal reviews. Gallery/map placeholders. |
| **2 (shipped)** | Photo gallery — public `venue-photos` Supabase Storage bucket + `venue_photos` table (RLS + enforce-org trigger) + dashboard upload/caption/reorder/delete + scroll-snap carousel on the rich page. JPEG/PNG/WebP, ≤5 MB, ≤12/venue. No new sub-processor (Supabase Storage, EU; photos are operator branding, not guest PII). |
| **3 (shipped)** | Stylised month-grid availability calendar on the rich page — `loadPublicMonthAvailability` classifies each day open/full/closed/past (one month-occupancy load + pure `findSlots` per day); only open days selectable, prev/next month nav, `month` URL param. Free/embed keep the native date input. |
| 4 | Map (from profile geo) + manual TripAdvisor/Google rating badges + opening hours/FAQ + polish. |

## User stories

- As a diner I see photos, a description, where the venue is, and what people think before I book.
- As a diner I see a trustworthy aggregate rating that includes the venue's Google reviews, not just on-platform ones.
- As an operator (Core/Plus) I fill in my venue's profile once and it appears on my booking page.
- As an operator I can show my TripAdvisor rating as a badge that links to my TripAdvisor page (we cannot pull TripAdvisor review data — their API excludes B2B SaaS).

## Gating

- The **rich page** is gated `hasPlan(plan, "core")` — a public render branch on `app/(widget)/book/[venueIdOrSlug]/page.tsx`, not a paywalled dashboard surface (no `LockedFeature` overlay, no new `entitlements.ts` feature). Free → today's simple body.
- **Plus theming** (`widget.md` §Operator theming) is orthogonal and unchanged: it layers on via the existing `WidgetThemeProvider` whichever body renders.

## Venue profile — `venues.settings.profile`

Stored as a typed JSONB slice (no migration; mirrors the `branding` slice). Parsed by `lib/venues/profile.ts` `parseProfile` — lenient (salvage valid fields, never throw), like `parseBranding`.

```
description?: string            // ≤ 2000
cuisine?:     string            // ≤ 80, free text e.g. "Modern British"
priceRange?:  "£" | "££" | "£££" | "££££"
address?: { street?, city?, postcode? }   // each lenient, short
phone?:       string            // ≤ 32
website?:     string            // https only, ≤ 2048
latitude?:    number            // -90..90  — stored for the Phase-4 map, not rendered in Phase 1
longitude?:   number            // -180..180
```

Operators edit these in the existing General venue settings (`/dashboard/venues/[venueId]/settings`).

## Reviews — `loadPublicReviews(venueId)`

Returns `{ average, count, bySource: { internal, google }, items[] }`.

- **Aggregate** (SQL `count`/`avg`, no decrypt): internal reviews with `showcaseConsentAt IS NOT NULL` and guest `erasedAt IS NULL`, plus all `source="google"` rows (already public; `guestId` null). **All ratings count** (the aggregate reflects real sentiment, not only ≥4). The legacy `loadPublicShowcase` (rating ≥4, limit 3) is unchanged and only used by the Free page.
- **List** (bounded decrypt — the cost driver): top N per source (default 3) by `submittedAt desc`. **Google review comments are encrypted** (`lib/google/sync-reviews.ts` stores them via `encryptPii`), so both internal and google comments are read via `decryptPii(row.organisationId, commentCipher)`; decrypt failures are silently skipped (as `loadPublicShowcase` does). Author = guest `firstName` (internal) / `reviewerDisplayName` (google). Comment-less google rows count toward the aggregate with `comment: null`.

## Acceptance criteria

- [ ] Core/Plus `/book/<slug>` renders the rich layout (info header + booking panel + About + reviews + gallery/map placeholders); Free renders the existing simple body unchanged.
- [ ] Aggregate rating + count combine consented-internal + google; non-consented and erased-guest internal reviews excluded.
- [ ] Profile round-trips via dashboard settings without clobbering the `branding`/`messaging` slices.
- [ ] Plus theming still applies on the rich page; Core uses default Tablekit styling.
- [ ] The `/embed` iframe is byte-for-byte unchanged (no rich imports; auto-height unaffected).
- [ ] Public response never exposes `organisationId`, raw `settings`, or guest email/last name.

## Technical notes

- All new components are server components under the book route, imported only by `page.tsx` (`star-rating.tsx`, `profile.tsx`, `reviews.tsx`). Reuse `components/ui` + `@theme` tokens; no new UI dependencies.
- Reads stay in `lib/public/venue.ts` via `adminDb` with explicit column projection; `organisationId`/raw `settings` are used internally (for decrypt) and never returned in a DTO.

## Out of scope

- Pulling **TripAdvisor** review *data* — their Content API is partnership-gated and excludes B2B SaaS (caching bans + mandatory attribution). Phase 4 ships a manual operator-entered rating badge + link-out only.
- Google **Places** API (photos/metadata) — costlier, caching-restricted; the existing Business Profile sync already gives us reviews.
- Search / discovery / marketplace across venues (year-1 non-goal) — hence profile lives in JSONB, not indexed columns.

## Deferred

Phases 2–4 (gallery, calendar, map + badges) — each its own PR set, tracked above.
