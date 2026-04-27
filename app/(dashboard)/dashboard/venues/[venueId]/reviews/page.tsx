// Operator reviews list. Shows the venue's submitted reviews with a
// stats header (avg rating, response rate, last 7 days) and an inline
// reply form per row. Phase 2 — internal source only; future phases
// pull Google / TripAdvisor into the same table.

import { and, desc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { guests, reviews, venues } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";

import { ReviewRow } from "./forms";

export const metadata = { title: "Reviews · TableKit" };

type SearchParams = { rating?: string; replied?: string };

export default async function ReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { orgId } = await requireRole("host");
  const { venueId } = await params;
  const sp = await searchParams;

  const ratingFilter = sp.rating ? Number(sp.rating) : null;
  const repliedFilter = sp.replied === "yes" ? true : sp.replied === "no" ? false : null;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  // Reads go through withUser so RLS scopes them; the venue check
  // above already 404s if the user doesn't have access.
  const rows = await withUser(async (db) => {
    const conditions = [eq(reviews.venueId, venueId)];
    if (ratingFilter !== null && [1, 2, 3, 4, 5].includes(ratingFilter)) {
      conditions.push(eq(reviews.rating, ratingFilter));
    }
    if (repliedFilter === true) {
      conditions.push(sql`${reviews.respondedAt} is not null`);
    } else if (repliedFilter === false) {
      conditions.push(sql`${reviews.respondedAt} is null`);
    }
    return db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        commentCipher: reviews.commentCipher,
        responseCipher: reviews.responseCipher,
        respondedAt: reviews.respondedAt,
        submittedAt: reviews.submittedAt,
        source: reviews.source,
        guestFirstName: guests.firstName,
      })
      .from(reviews)
      .innerJoin(guests, eq(guests.id, reviews.guestId))
      .where(and(...conditions))
      .orderBy(desc(reviews.submittedAt))
      .limit(100);
  });

  // Stats — single aggregate query, RLS-scoped via withUser. The
  // last-7d slice is computed in SQL with `now() - interval` so we
  // don't reach for Date.now() in a server-component render.
  const stats = await withUser(async (db) => {
    const [agg] = await db
      .select({
        total: sql<number>`count(*)::int`,
        avgRating: sql<number | null>`avg(${reviews.rating})::float`,
        responded: sql<number>`count(${reviews.respondedAt})::int`,
        last7d: sql<number>`count(*) filter (where ${reviews.submittedAt} >= now() - interval '7 days')::int`,
      })
      .from(reviews)
      .where(eq(reviews.venueId, venueId));
    return agg ?? { total: 0, avgRating: null, responded: 0, last7d: 0 };
  });

  // Decrypt comments + responses for display. Done in the page (not
  // the row component) so plaintext never crosses a client-component
  // boundary — the row receives strings, not Ciphertext.
  const display = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      rating: r.rating,
      source: r.source,
      submittedAt: r.submittedAt,
      respondedAt: r.respondedAt,
      guestFirstName: r.guestFirstName,
      comment: r.commentCipher
        ? await decryptPii(orgId, r.commentCipher as Ciphertext).catch(() => "[decrypt failed]")
        : null,
      response: r.responseCipher
        ? await decryptPii(orgId, r.responseCipher as Ciphertext).catch(() => "[decrypt failed]")
        : null,
    })),
  );

  const responseRate =
    stats.total > 0 ? Math.round((stats.responded / stats.total) * 100) : null;
  const avg = stats.avgRating ? stats.avgRating.toFixed(1) : "—";

  return (
    <section className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Average rating" value={avg} sub={`${stats.total} total`} />
        <Stat
          label="Reply rate"
          value={responseRate === null ? "—" : `${responseRate}%`}
          sub={`${stats.responded} replied`}
        />
        <Stat label="Last 7 days" value={String(stats.last7d)} sub="new reviews" />
      </div>

      <Filters venueId={venueId} rating={ratingFilter} replied={repliedFilter} />

      <ul className="flex flex-col gap-3">
        {display.length === 0 ? (
          <li className="rounded-card border border-hairline bg-cloud p-6 text-sm text-ash">
            No reviews match the current filter.
          </li>
        ) : (
          display.map((r) => <ReviewRow key={r.id} venueId={venueId} review={r} />)
        )}
      </ul>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-card border border-hairline bg-white p-4">
      <p className="text-xs uppercase tracking-wider text-ash">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-xs text-ash">{sub}</p>
    </div>
  );
}

function Filters({
  venueId,
  rating,
  replied,
}: {
  venueId: string;
  rating: number | null;
  replied: boolean | null;
}) {
  const base = `/dashboard/venues/${venueId}/reviews`;
  const ratingHref = (n: number | null) => {
    const params = new URLSearchParams();
    if (n !== null) params.set("rating", String(n));
    if (replied !== null) params.set("replied", replied ? "yes" : "no");
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const repliedHref = (v: "yes" | "no" | null) => {
    const params = new URLSearchParams();
    if (rating !== null) params.set("rating", String(rating));
    if (v !== null) params.set("replied", v);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <FilterPill label="All ratings" href={ratingHref(null)} active={rating === null} />
      {[5, 4, 3, 2, 1].map((n) => (
        <FilterPill
          key={n}
          label={`${n}★`}
          href={ratingHref(n)}
          active={rating === n}
        />
      ))}
      <span className="mx-2 self-center text-stone">·</span>
      <FilterPill label="Any" href={repliedHref(null)} active={replied === null} />
      <FilterPill label="Awaiting reply" href={repliedHref("no")} active={replied === false} />
      <FilterPill label="Replied" href={repliedHref("yes")} active={replied === true} />
    </div>
  );
}

function FilterPill({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <a
      href={href}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? "border-ink bg-ink text-white"
          : "border-hairline bg-white text-ash hover:border-ink hover:text-ink"
      }`}
    >
      {label}
    </a>
  );
}
