import { asc, eq } from "drizzle-orm";
import { ArrowRight, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { getActiveOrg } from "@/lib/auth/active-org";
import { requireRole } from "@/lib/auth/require-role";
import { todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { withUser } from "@/lib/db/client";
import { organisations, venues } from "@/lib/db/schema";
import { getCoversReport } from "@/lib/reports/covers";
import { getDepositRevenueReport } from "@/lib/reports/deposits";

export const metadata = { title: "Overview · TableKit" };
export const dynamic = "force-dynamic";

// Group dashboard for the active org. Aggregates today's headline
// numbers across all venues (bookings, realised covers, deposit
// revenue). RLS scopes the venue list automatically; per-venue
// reports run in parallel via Promise.all.
//
// Single-venue orgs are bounced to that venue's bookings page —
// the overview is a group-tier surface, not a re-skin of the
// single-venue dashboard.

export default async function OverviewPage() {
  await requireRole("host");
  const activeOrgId = await getActiveOrg();
  if (!activeOrgId) redirect("/login?error=no_active_org");

  const { org, venueRows } = await withUser(async (db) => {
    const [o] = await db
      .select({
        id: organisations.id,
        name: organisations.name,
        groupCrmEnabled: organisations.groupCrmEnabled,
      })
      .from(organisations)
      .where(eq(organisations.id, activeOrgId))
      .limit(1);
    const v = await db
      .select({ id: venues.id, name: venues.name, timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.organisationId, activeOrgId))
      .orderBy(asc(venues.name));
    return { org: o, venueRows: v };
  });

  if (!org) throw new Error("Overview: org not found under active session");

  // Single-venue orgs don't need this page — bounce to the venue.
  if (venueRows.length <= 1) {
    if (venueRows.length === 1) {
      redirect(`/dashboard/venues/${venueRows[0]!.id}/bookings`);
    }
    redirect("/dashboard/venues/new");
  }

  // Per-venue headline for today (venue-local). Queries run serially
  // inside the transaction — one pg client per tx, so Promise.all
  // would just collide on the same connection.
  const tiles = await withUser(async (db) => {
    const out: Array<{
      venueId: string;
      venueName: string;
      today: string;
      bookings: number;
      coversBooked: number;
      coversRealised: number;
      netMinor: number;
    }> = [];
    for (const v of venueRows) {
      const today = todayInZone(v.timezone);
      const bounds = {
        ...venueLocalDayRange(today, v.timezone),
        timezone: v.timezone,
      };
      const coverRows = await getCoversReport(db, v.id, bounds);
      const depositRows = await getDepositRevenueReport(db, v.id, bounds);
      out.push({
        venueId: v.id,
        venueName: v.name,
        today,
        bookings: coverRows.reduce((acc, r) => acc + r.bookings, 0),
        coversBooked: coverRows.reduce((acc, r) => acc + r.coversBooked, 0),
        coversRealised: coverRows.reduce((acc, r) => acc + r.coversRealised, 0),
        netMinor: depositRows.reduce((acc, r) => acc + r.netMinor, 0),
      });
    }
    return out;
  });

  const totals = tiles.reduce(
    (acc, t) => ({
      bookings: acc.bookings + t.bookings,
      coversBooked: acc.coversBooked + t.coversBooked,
      coversRealised: acc.coversRealised + t.coversRealised,
      netMinor: acc.netMinor + t.netMinor,
    }),
    { bookings: 0, coversBooked: 0, coversRealised: 0, netMinor: 0 },
  );

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <header className="border-hairline border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <LayoutDashboard className="text-coral h-6 w-6" aria-hidden />
          {org.name}
        </h1>
        <p className="text-ash mt-1 text-sm">
          Today across {venueRows.length} venues. Numbers refresh on page load — operators each see
          what their RLS scope allows.
        </p>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bookings today" value={String(totals.bookings)} />
        <Stat label="Covers booked" value={String(totals.coversBooked)} />
        <Stat label="Covers realised" value={String(totals.coversRealised)} />
        <Stat label="Deposit revenue (net)" value={gbp(totals.netMinor)} />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">By venue</h2>
        <ul className="flex flex-col gap-2">
          {tiles
            .slice()
            .sort((a, b) => b.bookings - a.bookings)
            .map((t) => (
              <li key={t.venueId}>
                <Link
                  href={`/dashboard/venues/${t.venueId}/bookings?date=${t.today}`}
                  className="group rounded-card border-hairline hover:border-ink flex items-center justify-between gap-4 border bg-white px-4 py-3 transition"
                >
                  <div className="flex flex-col">
                    <span className="text-ink text-sm font-semibold">{t.venueName}</span>
                    <span className="text-ash text-xs">
                      {t.bookings} {t.bookings === 1 ? "booking" : "bookings"} · {t.coversRealised}/
                      {t.coversBooked} covers · {gbp(t.netMinor)} net
                    </span>
                  </div>
                  <ArrowRight
                    className="text-mute group-hover:text-ink h-4 w-4 transition group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="sm">
      <p className="text-ash text-xs">{label}</p>
      <p className="text-ink text-2xl font-bold tracking-tight tabular-nums">{value}</p>
    </Card>
  );
}

function gbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const v = Math.abs(minor);
  return `${sign}£${(v / 100).toFixed(2)}`;
}
