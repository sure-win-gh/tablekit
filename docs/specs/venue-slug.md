# Spec: Venue URL slugs (friendly public routing)

**Status:** shipped (retrospective spec — backfilled after `39898d0`)
**Depends on:** `venues.md`, `widget.md`

## What we're building

A friendly URL form for the public booking page. Operators can pick a slug (`book.tablekit.uk/jane-cafe`) instead of relying on the UUID URL (`book.tablekit.uk/<uuid>`). Existing UUID URLs keep working forever — slugs are an addition, not a replacement.

The widget spec already references `book.tablekit.uk/<venue-slug>` aspirationally; this is its implementation.

## User stories

- As an operator I can pick a memorable URL for my booking page so it fits my Instagram bio / QR code / printed menu.
- As an operator I can change my slug later without breaking links shared in the past — UUID URLs keep working and 308-redirect to the current slug.
- As an operator I see field-level errors on the slug input (format, reserved name, taken) without losing the rest of my settings form.
- As a diner I land on a friendly URL whether I scan a QR or click a UUID link in an old email.

## Acceptance criteria

- [x] `venues.slug` column: `citext`, nullable, partial unique index where not null.
- [x] DB-level CHECK constraint mirrors the Zod regex (3–60 chars, lowercase letters / digits / single hyphens, no leading / trailing / consecutive hyphens).
- [x] Public route accepts UUID **or** slug at `/book/[venueIdOrSlug]` and `/embed/[venueIdOrSlug]`.
- [x] When a venue has a slug, `/book/<uuid>` 308-redirects to `/book/<slug>` so QR codes and bookmarks converge.
- [x] `/embed/<uuid>` does **not** redirect — the iframe URL is set once by the loader and a redirect would flash.
- [x] UUID-vs-slug dispatch is deterministic (UUID-shape regex check; slug regex forbids the UUID shape).
- [x] Reserved slugs cannot be claimed: `embed`, `book`, `widget.js`, `dashboard`, `api`, `_next`, `login`, `signup`, `admin`, `legal`, `privacy`, `security`, `review`, `unsubscribe`, `auth`.
- [x] Settings form: live "Public URL: …" preview, format/reserved/uniqueness errors surface as field-level messages.
- [x] Dashboard embed page prefers the slug in the snippet + hosted link once one is set; nudges to settings when not.
- [x] `venue.slug_updated` audit-log entry on every slug change (set, change, clear).
- [x] Validator (`lib/venues/slug.ts`) is pure + unit-tested (16 cases covering format, case folding, reserved names, UUID detection).

## Technical notes

- **Validator lives in `lib/venues/slug.ts`** — exports `SLUG_REGEX`, `RESERVED_SLUGS`, `looksLikeUuid`, `validateSlug`. Pure, no DB / framework deps. Form, server action, public route resolver, and tests all share the same source of truth.
- **Public route resolver** is `loadPublicVenueByIdOrSlug(idOrSlug)` in `lib/public/venue.ts`. Returns `{ venue, matchedBy: 'id' | 'slug', canonicalSlug }`. The page decides whether to render in place or `permanentRedirect()`.
- **`adminDb()` is used for the public lookup** by design — anonymous traffic isn't covered by the `authenticated`-role RLS policies. Same pattern the rest of `lib/public/venue.ts` already uses; the file is small and projects out non-public columns by hand.
- **Uniqueness collisions** surface as PostgreSQL `23505` from the partial unique index. The settings action wraps the update in `try/catch`, sniffs `err.code` (and `err.cause.code`), and returns a field-level "That slug is already taken." message rather than throwing.
- **Case folding**: the column is `citext` so `Jane-Cafe` and `jane-cafe` collide on uniqueness. The validator also lowercases on input so we always store the canonical form.
- **Defence in depth**: the DB CHECK + Zod parse + `validateSlug()` all enforce the same regex. Any code path that bypasses the form layer still can't insert a malformed slug.
- **Public API unchanged**: `/api/v1/bookings` continues to take UUIDs only. The widget form posts the resolved UUID, so the public contract doesn't change.
- **`public/widget.js` unchanged**: already URL-encodes `data-venue-id`, so passing a slug works without modification.

## Out of scope (deferred)

- **Slug aliases on rename** — when an operator changes their slug, the old one becomes available for someone else. We could keep a `venue_slug_aliases` table that 308-redirects forever, but it's overkill until we have evidence of operators changing slugs in the wild.
- **Custom domains** (`bookings.jane-cafe.co.uk` → our hosted page). Real ask, but DNS + Cloudflare-for-SaaS / cert provisioning is a chunk of work. Separate spec when prioritised.
- **Slug suggestions on venue create** — auto-suggest `kebab-case(name)` and let the operator accept or edit. Nice-to-have UX; the manual settings field works for now.
- **`ALTER COLUMN slug SET NOT NULL`** — once 100% of venues have slugs and the UUID route is purely a redirect, we can require the column. Forward-only path: add the slug → backfill on venue create → ratchet to NOT NULL across two releases per the migration playbook.
- **Reserve from the public-route directory tree automatically** — the `RESERVED_SLUGS` set is hand-maintained. A test that walks `app/` and asserts every top-level directory is in the set would close the drift risk; not yet built.

## Where the code lives

- Schema: [`lib/db/schema.ts`](../../lib/db/schema.ts) (venues table, partial unique index)
- Migration: [`drizzle/migrations/0022_groovy_excalibur.sql`](../../drizzle/migrations/0022_groovy_excalibur.sql)
- Validator: [`lib/venues/slug.ts`](../../lib/venues/slug.ts)
- Public lookup: [`lib/public/venue.ts`](../../lib/public/venue.ts) — `loadPublicVenueByIdOrSlug`
- Public routes: `app/(widget)/book/[venueIdOrSlug]/`, `app/(widget)/embed/[venueIdOrSlug]/`
- Settings UI: `app/(dashboard)/dashboard/venues/[venueId]/settings/{actions,form,page}.tsx`
- Audit action: `venue.slug_updated` in `lib/server/admin/audit.ts`
- Tests: [`tests/unit/venues-slug.test.ts`](../../tests/unit/venues-slug.test.ts)
