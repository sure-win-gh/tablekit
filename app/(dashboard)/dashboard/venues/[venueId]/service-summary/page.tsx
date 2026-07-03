import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, cn } from "@/components/ui";
import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { formatVenueTime, todayInZone } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";
import { getHeatmap } from "@/lib/services/heatmap";
import { getServiceSuggestions } from "@/lib/services/suggestions/context";
import type { Suggestion } from "@/lib/services/suggestions/types";
import { getDayPrep, getServiceSummary, type ServiceSummaryRow } from "@/lib/services/summary";

import { HeatmapCalendar, ServiceSummaryDateNav } from "./forms";

export const metadata = { title: "Service summary · TableKit" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ServiceSummaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { orgId } = await requireRole("host");
  const plan = await getPlan(orgId);
  if (isLocked(plan, "serviceSummary")) {
    return <LockedFeature feature="serviceSummary" currentPlan={plan} />;
  }

  const { venueId } = await params;
  const { date: dateParam } = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const today = todayInZone(venue.timezone);
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : today;
  const monthFirst = `${date.slice(0, 7)}-01`;

  const { rows, suggestions, heatmap, prep } = await withUser(async (db) => {
    // Summary, heatmap, and prep are independent — fan out; only the
    // suggestions need the summary rows.
    const [rows, heatmap, prep] = await Promise.all([
      getServiceSummary(db, venueId, date, venue.timezone),
      getHeatmap(db, venueId, monthFirst, venue.timezone),
      getDayPrep(db, venueId, date, venue.timezone),
    ]);
    const suggestions = await getServiceSuggestions(db, venueId, date, venue.timezone, rows);
    return { rows, suggestions, heatmap, prep };
  });

  // Day totals derived from the already-fetched service rows.
  const totalCapacity = rows.reduce((s, r) => s + r.capacity, 0);
  const totalCovers = rows.reduce((s, r) => s + r.bookedCovers, 0);
  const totalBookings = rows.reduce((s, r) => s + r.bookingsCount, 0);
  const totalOpenSlots = rows.reduce((s, r) => s + r.openSlots, 0);
  const dayUtilisation = totalCapacity === 0 ? 0 : totalCovers / totalCapacity;

  const fired = rows
    .map((r) => ({ row: r, suggestion: suggestions.get(r.serviceId) }))
    .filter((x): x is { row: ServiceSummaryRow; suggestion: Suggestion } => Boolean(x.suggestion));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-ink text-xl font-bold tracking-tight">Service summary</h2>
          <p className="text-ash mt-0.5 text-sm">
            How full each service is against capacity, plus what the floor needs to know. Times are
            in this venue&apos;s local zone.
          </p>
        </div>
        <ServiceSummaryDateNav venueId={venueId} date={date} today={today} />
      </div>

      {fired.length > 0 ? (
        <div className="rounded-card border-coral/40 bg-coral/5 flex flex-wrap items-center gap-2 border px-3 py-2">
          <span className="text-coral-deep text-xs font-bold tracking-wide uppercase">
            Worth a look
          </span>
          {fired.map(({ row, suggestion }) => (
            <span
              key={row.serviceId}
              className={cn(
                "rounded-pill border bg-white px-2.5 py-0.5 text-xs font-semibold",
                suggestion.rule === "oversold-risk"
                  ? "border-rose/40 text-rose"
                  : "border-coral/40 text-coral-deep",
              )}
            >
              {row.serviceName}: {suggestion.message}
            </span>
          ))}
        </div>
      ) : null}

      {/* Note: prep counts every non-cancelled booking on the day, while
          the capacity KPIs cover only services scheduled today — if a
          schedule changed after bookings were taken, prep can exceed
          what the service rows imply. Deliberate: the floor still has
          to serve those bookings. */}
      {rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi
            label="Covers booked"
            value={`${totalCovers}/${totalCapacity}`}
            sub={`${Math.round(dayUtilisation * 100)}% of capacity`}
            accent={dayUtilisation >= 0.95}
          />
          <Kpi label="Bookings" value={String(totalBookings)} />
          <Kpi label="Open slots" value={String(totalOpenSlots)} sub="for a party of 2" />
          <Kpi
            label="Largest party"
            value={prep.largestParty === 0 ? "—" : String(prep.largestParty)}
          />
          <Kpi
            label="High chairs"
            value={prep.highChairs === 0 ? "—" : String(prep.highChairs)}
            sub={prep.highChairs > 0 ? "needed today" : undefined}
          />
          <Kpi
            label="Dietary notes"
            value={prep.dietaryNotesCount === 0 ? "—" : String(prep.dietaryNotesCount)}
            sub={prep.dietaryNotesCount > 0 ? "bookings — see timeline" : undefined}
            href={
              prep.dietaryNotesCount > 0
                ? `/dashboard/venues/${venueId}/timeline?date=${date}`
                : undefined
            }
          />
        </div>
      ) : null}

      <Card>
        <CardBody>
          <HeatmapCalendar
            venueId={venueId}
            selectedDate={date}
            monthFirst={monthFirst}
            days={heatmap}
          />
        </CardBody>
      </Card>

      {rows.length === 0 ? (
        <p className="border-hairline text-ash rounded-card border border-dashed bg-white p-6 text-center text-sm">
          No services scheduled on this day.
        </p>
      ) : (
        <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
          {rows.map((r) => (
            <ServiceRow
              key={r.serviceId}
              row={r}
              timezone={venue.timezone}
              suggestion={suggestions.get(r.serviceId)}
              timelineHref={`/dashboard/venues/${venueId}/timeline?date=${date}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent = false,
  href,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  accent?: boolean;
  href?: string | undefined;
}) {
  const body = (
    <>
      <div className="text-ash text-[11px] font-semibold tracking-wide uppercase">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-2xl font-bold tracking-tight tabular-nums",
          accent ? "text-coral-deep" : "text-ink",
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-ash text-[11px]">{sub}</div> : null}
    </>
  );
  const cls = "rounded-card border-hairline shadow-panel border bg-white px-4 py-3";
  return href ? (
    <Link href={href} className={cn(cls, "hover:border-ink block transition")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// Utilisation thresholds mirror the spec (70% / 95%) on design tokens:
// calm ink, warming coral, full rose.
function barTone(u: number): string {
  if (u >= 0.95) return "bg-rose";
  if (u >= 0.7) return "bg-coral";
  return "bg-ink";
}

const SUGGESTION_TONE: Record<string, string> = {
  "oversold-risk": "border-rose/40 text-rose bg-rose/5",
  "no-show-cluster": "border-coral/40 text-coral-deep bg-coral/5",
  "underbooked-72h": "border-hairline text-ash bg-cloud",
  "walk-in-headroom": "border-hairline text-ash bg-cloud",
};

function ServiceRow({
  row,
  timezone,
  suggestion,
  timelineHref,
}: {
  row: ServiceSummaryRow;
  timezone: string;
  suggestion?: Suggestion | undefined;
  timelineHref: string;
}) {
  const pct = Math.round(row.utilisation * 100);
  const avgParty =
    row.bookingsCount === 0 ? null : (row.bookedCovers / row.bookingsCount).toFixed(1);
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ash w-24 shrink-0 text-xs tabular-nums">
          {formatVenueTime(row.windowStart, { timezone })}–
          {formatVenueTime(row.windowEnd, { timezone })}
        </span>
        <span className="text-ink min-w-0 flex-1 truncate text-sm font-semibold">
          {row.serviceName}
        </span>
        <span className="bg-cloud relative h-2.5 w-40 shrink-0 overflow-hidden rounded-full">
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", barTone(row.utilisation))}
            style={{ width: `${Math.min(100, pct)}%` }}
            aria-hidden
          />
        </span>
        <span className="text-ink w-28 shrink-0 text-right text-xs font-semibold tabular-nums">
          {row.bookedCovers}/{row.capacity} · {pct}%
        </span>
        <Link
          href={timelineHref}
          className="text-coral shrink-0 text-xs font-semibold underline-offset-2 hover:underline"
        >
          Timeline →
        </Link>
      </div>
      <div className="text-ash flex flex-wrap items-center gap-x-3 gap-y-1 pl-27 text-[11px]">
        <span className="tabular-nums">{row.bookingsCount} bookings</span>
        {avgParty ? <span className="tabular-nums">avg party {avgParty}</span> : null}
        <span className="tabular-nums">{row.openSlots} open slots</span>
        <span className="tabular-nums">{row.turnMinutes}min turns</span>
        {suggestion ? (
          <span
            className={cn(
              "rounded-pill border px-2 py-0.5 font-semibold",
              SUGGESTION_TONE[suggestion.rule] ?? "border-hairline text-ash bg-cloud",
            )}
          >
            {suggestion.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
