import { desc, eq } from "drizzle-orm";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { specialEvents, venues } from "@/lib/db/schema";

import { EventRow, NewEventForm } from "./forms";

export const metadata = {
  title: "Special events · TableKit",
};

export default async function EventsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { orgId } = await requireRole("manager");
  const plan = await getPlan(orgId);
  if (isLocked(plan, "events")) {
    return <LockedFeature feature="events" currentPlan={plan} />;
  }
  const { venueId } = await params;

  const { events, timezone } = await withUser(async (db) => {
    const [venue] = await db
      .select({ timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    const rows = await db
      .select({
        id: specialEvents.id,
        name: specialEvents.name,
        slug: specialEvents.slug,
        startsAt: specialEvents.startsAt,
        endsAt: specialEvents.endsAt,
        status: specialEvents.status,
        blockScope: specialEvents.blockScope,
        externalTicketUrl: specialEvents.externalTicketUrl,
      })
      .from(specialEvents)
      .where(eq(specialEvents.venueId, venueId))
      .orderBy(desc(specialEvents.startsAt));

    return { events: rows, timezone: venue?.timezone ?? "Europe/London" };
  });

  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timezone,
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });

  const rows = events.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    status: e.status,
    externalTicketUrl: e.externalTicketUrl,
    dateLabel: dateFmt.format(e.startsAt),
    timeLabel:
      e.blockScope === "whole_day"
        ? "All day"
        : `${timeFmt.format(e.startsAt)}–${timeFmt.format(e.endsAt)}`,
  }));

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Special events</h2>
        <p className="text-ash mt-0.5 text-sm">
          Block a date from standard table bookings to run a ticketed event day. Published events
          close the widget for their window; add a ticket link so guests can still book in.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="border-hairline text-ash rounded-card border border-dashed bg-white p-6 text-center text-sm">
          No events yet — add one below to hold a date for a special event.
        </p>
      ) : (
        <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
          {rows.map((r) => (
            <EventRow key={r.id} event={r} venueId={venueId} />
          ))}
        </div>
      )}

      <NewEventForm venueId={venueId} startOpen={rows.length === 0} />
    </section>
  );
}
