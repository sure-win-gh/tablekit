// Public venue-info reads for the widget flow.
//
// Uses `adminDb` to bypass RLS because the `authenticated`-role
// policies don't cover anonymous traffic by design. The trade-off is
// that this file must be careful about what it returns — anything
// that isn't meant to be public-visible must be projected out here.

import "server-only";

import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import {
  bookingTables,
  guests,
  organisations,
  reviews,
  services,
  venuePhotos,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";
import {
  findSlots,
  type ServiceSpec,
  type Slot,
  type TableSpec,
} from "@/lib/bookings/availability";
import { isWholeVenue, loadEventClosures } from "@/lib/bookings/closures";
import { loadVenueCombining } from "@/lib/bookings/combinable";
import { todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { daysInMonth } from "@/lib/services/calendar";
import { type Plan, toPlan } from "@/lib/auth/plan-level";
import { parseBranding } from "@/lib/messaging/venue-settings";
import type { VenueBranding } from "@/lib/messaging/context";
import { parseProfile, type VenueProfile } from "@/lib/venues/profile";
import { venuePhotoPublicUrl } from "@/lib/venues/photos";

export type PublicVenue = {
  id: string;
  name: string;
  timezone: string;
  locale: string;
};

export async function loadPublicVenue(venueId: string): Promise<PublicVenue | null> {
  const db = adminDb();
  const [row] = await db
    .select({
      id: venues.id,
      name: venues.name,
      timezone: venues.timezone,
      locale: venues.locale,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return row ?? null;
}

// Public-route resolver — accepts either a UUID or a slug and returns
// the venue plus enough context for the page to decide whether to
// redirect (UUID → canonical slug URL) or render in-place. Returns
// null when neither matches.
export type VenueLookup = {
  venue: PublicVenue;
  matchedBy: "id" | "slug";
  canonicalSlug: string | null;
  // Owning org's plan + parsed branding — for widget theming gating only.
  // Derived here (not in the public PublicVenue DTO) so organisationId and
  // raw settings never leak into a response payload.
  plan: Plan;
  branding: VenueBranding | undefined;
  // Parsed public profile (Core+ rich page). Derived from settings, raw
  // settings stay out of the DTO.
  profile: VenueProfile | undefined;
};

export async function loadPublicVenueByIdOrSlug(idOrSlug: string): Promise<VenueLookup | null> {
  // Lazy-import the helper so this server-only module stays
  // dependency-free at the type layer.
  const { looksLikeUuid } = await import("@/lib/venues/slug");
  const matchedBy: "id" | "slug" = looksLikeUuid(idOrSlug) ? "id" : "slug";
  const where = matchedBy === "id" ? eq(venues.id, idOrSlug) : eq(venues.slug, idOrSlug);
  const db = adminDb();
  const [row] = await db
    .select({
      id: venues.id,
      name: venues.name,
      timezone: venues.timezone,
      locale: venues.locale,
      slug: venues.slug,
      plan: organisations.plan,
      settings: venues.settings,
    })
    .from(venues)
    .innerJoin(organisations, eq(organisations.id, venues.organisationId))
    .where(where)
    .limit(1);
  if (!row) return null;
  return {
    venue: { id: row.id, name: row.name, timezone: row.timezone, locale: row.locale },
    matchedBy,
    canonicalSlug: row.slug ?? null,
    plan: toPlan(row.plan),
    branding: parseBranding(row.settings),
    profile: parseProfile(row.settings),
  };
}

export type PublicAvailabilityInput = {
  venueId: string;
  date: string; // YYYY-MM-DD, venue-local
  partySize: number;
};

export type PublicAvailability = {
  slots: Array<{
    serviceId: string;
    serviceName: string;
    wallStart: string;
    startAt: Date;
    endAt: Date;
  }>;
};

export async function loadPublicAvailability(
  venue: PublicVenue,
  input: { date: string; partySize: number },
): Promise<PublicAvailability> {
  const db = adminDb();

  const [serviceRows, tableRows] = await Promise.all([
    db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venue.id)),
    db
      .select({
        id: venueTables.id,
        areaId: venueTables.areaId,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venue.id)),
  ]);

  const { startUtc, endUtc } = venueLocalDayRange(input.date, venue.timezone);
  const [occupied, closures] = await Promise.all([
    db
      .select({
        tableId: bookingTables.tableId,
        startAt: bookingTables.startAt,
        endAt: bookingTables.endAt,
      })
      .from(bookingTables)
      .where(
        and(
          eq(bookingTables.venueId, venue.id),
          gte(bookingTables.startAt, startUtc),
          lt(bookingTables.startAt, endUtc),
        ),
      ),
    loadEventClosures(db, venue.id, startUtc, endUtc),
  ]);

  const serviceSpecs: ServiceSpec[] = serviceRows.map((s) => ({
    id: s.id,
    name: s.name,
    schedule: s.schedule as ServiceSpec["schedule"],
    turnMinutes: s.turnMinutes,
  }));
  const tableSpecs: TableSpec[] = tableRows;
  const { combinable, maxCombineTables } = await loadVenueCombining(db, venue.id);

  const slots: Slot[] = findSlots({
    timezone: venue.timezone,
    date: input.date,
    partySize: input.partySize,
    services: serviceSpecs,
    tables: tableSpecs,
    occupied,
    combinable,
    maxCombineTables,
    closures,
  });

  return {
    slots: slots.map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      wallStart: s.wallStart,
      startAt: s.startAt,
      endAt: s.endAt,
    })),
  };
}

// --- Month availability (rich page calendar shading) ------------------------

export type DayAvailability = "open" | "full" | "closed" | "past" | "event";
export type MonthAvailability = {
  month: string; // YYYY-MM
  days: Record<string, DayAvailability>; // dateYMD -> classification
  // For "event" days: the published event to deep-link to (slug + name).
  events: Record<string, { slug: string; name: string }>;
};

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// Classify every day of a month for the rich page's calendar. Loads services +
// tables + the whole month's occupancy ONCE, then runs the pure findSlots per
// day (no per-day DB query). A day is:
//   past   — before today in the venue zone
//   event  — a published special event blocks standard bookings that day
//   closed — no service runs that weekday
//   full   — services run but every slot is taken for this party size
//   open   — at least one slot is bookable
export async function loadPublicMonthAvailability(
  venue: PublicVenue,
  input: { month: string; partySize: number },
): Promise<MonthAvailability> {
  const db = adminDb();
  const [yearStr, monthStr] = input.month.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12
  const dim = daysInMonth(year, month);
  const firstYmd = `${input.month}-01`;
  const lastYmd = `${input.month}-${String(dim).padStart(2, "0")}`;

  const [serviceRows, tableRows] = await Promise.all([
    db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venue.id)),
    db
      .select({
        id: venueTables.id,
        areaId: venueTables.areaId,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venue.id)),
  ]);

  const { startUtc } = venueLocalDayRange(firstYmd, venue.timezone);
  const { endUtc } = venueLocalDayRange(lastYmd, venue.timezone);
  // Occupancy + closures across the whole month in one round-trip each.
  // findSlots only overlaps same-day candidate slots, so passing the full
  // month set is correct for both. The closures query also carries the
  // event slug/name so the calendar can deep-link each "event" day.
  const [occupied, closures] = await Promise.all([
    db
      .select({
        tableId: bookingTables.tableId,
        startAt: bookingTables.startAt,
        endAt: bookingTables.endAt,
      })
      .from(bookingTables)
      .where(
        and(
          eq(bookingTables.venueId, venue.id),
          gte(bookingTables.startAt, startUtc),
          lt(bookingTables.startAt, endUtc),
        ),
      ),
    loadEventClosures(db, venue.id, startUtc, endUtc),
  ]);

  const serviceSpecs: ServiceSpec[] = serviceRows.map((s) => ({
    id: s.id,
    name: s.name,
    schedule: s.schedule as ServiceSpec["schedule"],
    turnMinutes: s.turnMinutes,
  }));
  const tableSpecs: TableSpec[] = tableRows;
  const today = todayInZone(venue.timezone);
  const { combinable, maxCombineTables } = await loadVenueCombining(db, venue.id);

  const days: Record<string, DayAvailability> = {};
  const events: Record<string, { slug: string; name: string }> = {};
  for (let d = 1; d <= dim; d++) {
    const ymd = `${input.month}-${String(d).padStart(2, "0")}`;
    if (ymd < today) {
      days[ymd] = "past";
      continue;
    }
    // Published blocking events covering this day. A WHOLE-VENUE event
    // trumps open/full/closed — the date is sold as tickets, not tables.
    // An AREA-SCOPED event still lands in `events` (the calendar shows a
    // banner) but the day classifies normally from the remaining tables
    // (findSlots strips the scoped areas' tables itself).
    const { startUtc: dayStart, endUtc: dayEnd } = venueLocalDayRange(ymd, venue.timezone);
    const covering = closures.filter(
      (c) => c.startAt.getTime() < dayEnd.getTime() && c.endAt.getTime() > dayStart.getTime(),
    );
    const firstCovering = covering[0];
    if (firstCovering) {
      events[ymd] = { slug: firstCovering.slug, name: firstCovering.name };
    }
    const wholeVenue = covering.find(isWholeVenue);
    if (wholeVenue) {
      days[ymd] = "event";
      events[ymd] = { slug: wholeVenue.slug, name: wholeVenue.name };
      continue;
    }
    const dow = DOW_KEYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;
    if (!serviceSpecs.some((s) => s.schedule.days.includes(dow))) {
      days[ymd] = "closed";
      continue;
    }
    const slots = findSlots({
      timezone: venue.timezone,
      date: ymd,
      partySize: input.partySize,
      services: serviceSpecs,
      tables: tableSpecs,
      occupied,
      combinable,
      maxCombineTables,
      closures,
    });
    days[ymd] = slots.length > 0 ? "open" : "full";
  }
  return { month: input.month, days, events };
}

export type PublicShowcaseReview = {
  id: string;
  rating: number;
  firstName: string;
  comment: string;
  submittedAt: Date;
};

// Top consented reviews for the public booking widget. Internal-only,
// rating >= 4, with a comment, where the guest ticked the consent
// box. We never surface email or last name. The query relies on the
// reviews_showcase_idx partial index for cheap range scans.
//
// Returns an empty list when the venue's showcase is disabled — the
// caller doesn't need to know whether the toggle is off vs no
// eligible reviews exist.
export async function loadPublicShowcase(venueId: string): Promise<PublicShowcaseReview[]> {
  const db = adminDb();
  const [venue] = await db
    .select({ id: venues.id, organisationId: venues.organisationId, settings: venues.settings })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  if (!venue) return [];
  const settings = (venue.settings ?? {}) as Record<string, unknown>;
  if (settings["showcaseEnabled"] !== true) return [];

  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      commentCipher: reviews.commentCipher,
      submittedAt: reviews.submittedAt,
      firstName: guests.firstName,
    })
    .from(reviews)
    .innerJoin(guests, eq(guests.id, reviews.guestId))
    .where(
      and(
        eq(reviews.venueId, venueId),
        eq(reviews.source, "internal"),
        isNotNull(reviews.showcaseConsentAt),
        isNotNull(reviews.commentCipher),
        sql`${reviews.rating} >= 4`,
        // Belt-and-braces: erasure scrubs comment_cipher (which the
        // predicate above already drops), but the contract is that
        // erased guests do not appear on public surfaces regardless
        // of the cipher state.
        isNull(guests.erasedAt),
      ),
    )
    .orderBy(desc(reviews.submittedAt))
    .limit(3);

  const decrypted = await Promise.all(
    rows.map(async (r) => {
      // Decrypt failures are skipped — the showcase silently drops
      // unreadable rows rather than surface "[error]" placeholders to
      // public visitors. We do log so corruption is observable in
      // ops telemetry; only review id + venue id, never the cipher.
      try {
        const comment = await decryptPii(venue.organisationId, r.commentCipher as Ciphertext);
        return {
          id: r.id,
          rating: r.rating,
          firstName: r.firstName,
          comment,
          submittedAt: r.submittedAt,
        } satisfies PublicShowcaseReview;
      } catch {
        console.error("[lib/public/venue.ts] showcase decrypt failed", {
          reviewId: r.id,
          venueId,
        });
        return null;
      }
    }),
  );
  return decrypted.filter((r): r is PublicShowcaseReview => r !== null);
}

// --- Rich page reviews (Core+) ----------------------------------------------
// Aggregate rating + a short list, combining consented internal reviews and
// already-synced Google reviews. See docs/specs/booking-page.md.

export type PublicReviewItem = {
  id: string;
  rating: number;
  author: string;
  comment: string;
  source: "internal" | "google";
  submittedAt: Date;
  externalUrl: string | null;
};

export type PublicReviews = {
  average: number; // 0 when count === 0; rounded to 1 dp
  count: number;
  bySource: { internal: number; google: number };
  // Rating distribution across BOTH sources — drives the TheFork-style
  // bars. Pure SQL filtered counts, no decrypt.
  distribution: { five: number; four: number; threeOrLess: number };
  items: PublicReviewItem[]; // newest-first, only reviews that have a comment
};

// What counts toward the aggregate:
//   - internal: showcase-consented, guest not erased (ALL ratings, not just >=4)
//   - google:   every synced row (already public; guestId is null)
// The aggregate is pure SQL count/avg (no decrypt). Only the displayed slice
// is decrypted — decrypt is the cost driver, so it's bounded per source.
// Google review comments are ALSO encrypted (lib/google/sync-reviews.ts uses
// encryptPii), so both sources decrypt the same way.
export async function loadPublicReviews(
  venueId: string,
  opts?: { listLimitPerSource?: number },
): Promise<PublicReviews> {
  const db = adminDb();
  const limit = opts?.listLimitPerSource ?? 3;

  const aggCols = {
    count: sql<number>`count(*)::int`,
    sum: sql<number>`coalesce(sum(${reviews.rating}), 0)::int`,
    five: sql<number>`count(*) filter (where ${reviews.rating} = 5)::int`,
    four: sql<number>`count(*) filter (where ${reviews.rating} = 4)::int`,
    threeOrLess: sql<number>`count(*) filter (where ${reviews.rating} <= 3)::int`,
  };
  const internalWhere = and(
    eq(reviews.venueId, venueId),
    eq(reviews.source, "internal"),
    isNotNull(reviews.showcaseConsentAt),
    isNull(guests.erasedAt),
  );
  const googleWhere = and(eq(reviews.venueId, venueId), eq(reviews.source, "google"));

  const [[internalAgg], [googleAgg], internalRows, googleRows] = await Promise.all([
    db
      .select(aggCols)
      .from(reviews)
      .innerJoin(guests, eq(guests.id, reviews.guestId))
      .where(internalWhere),
    db.select(aggCols).from(reviews).where(googleWhere),
    db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        commentCipher: reviews.commentCipher,
        submittedAt: reviews.submittedAt,
        organisationId: reviews.organisationId,
        firstName: guests.firstName,
      })
      .from(reviews)
      .innerJoin(guests, eq(guests.id, reviews.guestId))
      .where(and(internalWhere, isNotNull(reviews.commentCipher)))
      .orderBy(desc(reviews.submittedAt))
      .limit(limit),
    db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        commentCipher: reviews.commentCipher,
        submittedAt: reviews.submittedAt,
        organisationId: reviews.organisationId,
        reviewerDisplayName: reviews.reviewerDisplayName,
        externalUrl: reviews.externalUrl,
      })
      .from(reviews)
      .where(and(googleWhere, isNotNull(reviews.commentCipher)))
      .orderBy(desc(reviews.submittedAt))
      .limit(limit),
  ]);

  const count = (internalAgg?.count ?? 0) + (googleAgg?.count ?? 0);
  const sum = (internalAgg?.sum ?? 0) + (googleAgg?.sum ?? 0);
  const average = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;

  // Decrypt the bounded list only; unreadable rows are dropped from the
  // output (and logged for ops, never as a placeholder shown to visitors)
  // — same posture as loadPublicShowcase.
  const decryptItem = async (
    r: {
      id: string;
      rating: number;
      commentCipher: string | null;
      submittedAt: Date;
      organisationId: string;
    },
    source: "internal" | "google",
    author: string,
    externalUrl: string | null,
  ): Promise<PublicReviewItem | null> => {
    if (!r.commentCipher) return null;
    try {
      const comment = await decryptPii(r.organisationId, r.commentCipher as Ciphertext);
      return {
        id: r.id,
        rating: r.rating,
        author,
        comment,
        source,
        submittedAt: r.submittedAt,
        externalUrl,
      };
    } catch {
      console.error("[lib/public/venue.ts] review decrypt failed", { reviewId: r.id, venueId });
      return null;
    }
  };

  const decrypted = await Promise.all([
    ...internalRows.map((r) => decryptItem(r, "internal", r.firstName, null)),
    ...googleRows.map((r) =>
      decryptItem(r, "google", r.reviewerDisplayName || "Google reviewer", r.externalUrl),
    ),
  ]);

  const items = decrypted
    .filter((r): r is PublicReviewItem => r !== null)
    .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());

  return {
    average,
    count,
    bySource: { internal: internalAgg?.count ?? 0, google: googleAgg?.count ?? 0 },
    distribution: {
      five: (internalAgg?.five ?? 0) + (googleAgg?.five ?? 0),
      four: (internalAgg?.four ?? 0) + (googleAgg?.four ?? 0),
      threeOrLess: (internalAgg?.threeOrLess ?? 0) + (googleAgg?.threeOrLess ?? 0),
    },
    items,
  };
}

// --- Rich page photos (Core+) -----------------------------------------------

export type PublicPhoto = {
  id: string;
  url: string; // public bucket URL — venue photos are operator branding, public
  caption: string | null;
};

// Ordered gallery photos for the rich booking page. The bucket is public, so
// we return well-known object URLs (no signed-URL minting). storage_path is
// internal and never leaves this function.
export async function loadPublicPhotos(venueId: string): Promise<PublicPhoto[]> {
  const db = adminDb();
  const rows = await db
    .select({
      id: venuePhotos.id,
      storagePath: venuePhotos.storagePath,
      caption: venuePhotos.caption,
    })
    .from(venuePhotos)
    .where(eq(venuePhotos.venueId, venueId))
    .orderBy(asc(venuePhotos.sortOrder), asc(venuePhotos.createdAt));
  return rows.map((r) => ({
    id: r.id,
    url: venuePhotoPublicUrl(r.storagePath),
    caption: r.caption,
  }));
}

// --- Opening hours (rich page) ----------------------------------------------

export type OpeningWindow = { start: string; end: string }; // "HH:MM"
export type OpeningDay = { key: string; label: string; windows: OpeningWindow[] };

const OPENING_DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

// Per-day opening windows derived from the venue's services
// (services.schedule = { days, start, end }). Mon→Sun; a day with no service
// is closed (empty windows). Multiple services on a day yield multiple
// windows, sorted by start. Public, no PII.
export async function loadPublicOpeningHours(venueId: string): Promise<OpeningDay[]> {
  const db = adminDb();
  const rows = await db
    .select({ schedule: services.schedule })
    .from(services)
    .where(eq(services.venueId, venueId));

  const byDay = new Map<string, OpeningWindow[]>();
  for (const r of rows) {
    const s = r.schedule as { days?: unknown; start?: unknown; end?: unknown };
    if (!Array.isArray(s.days) || typeof s.start !== "string" || typeof s.end !== "string")
      continue;
    for (const d of s.days) {
      if (typeof d !== "string") continue;
      const list = byDay.get(d) ?? [];
      list.push({ start: s.start, end: s.end });
      byDay.set(d, list);
    }
  }

  return OPENING_DAYS.map(({ key, label }) => ({
    key,
    label,
    windows: (byDay.get(key) ?? []).sort((a, b) => a.start.localeCompare(b.start)),
  }));
}

// Resolve the organisation that owns a venue — needed by the API
// route to scope `createBooking` correctly. Kept separate from
// `loadPublicVenue` so the organisationId doesn't accidentally leak
// into a public response payload.
export async function resolveVenueOrg(venueId: string): Promise<string | null> {
  const db = adminDb();
  const [row] = await db
    .select({ organisationId: venues.organisationId })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return row?.organisationId ?? null;
}
