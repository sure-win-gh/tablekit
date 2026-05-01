import { and, asc, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { areas, guests, services, venueTables, waitlists } from "@/lib/db/schema";
import { estimateWaitMinutes } from "@/lib/waitlist/wait-time";

import { NewWalkInForm, WaitlistEntryRow } from "./forms";

export const metadata = {
  title: "Waitlist · TableKit",
};

export default async function WaitlistPage({ params }: { params: Promise<{ venueId: string }> }) {
  await requireRole("host");
  const { venueId } = await params;

  const { entries, tables, avgTurnMinutes } = await withUser(async (db) => {
    const entryRows = await db
      .select({
        id: waitlists.id,
        partySize: waitlists.partySize,
        notes: waitlists.notes,
        requestedAt: waitlists.requestedAt,
        guestFirstName: guests.firstName,
      })
      .from(waitlists)
      .innerJoin(guests, eq(guests.id, waitlists.guestId))
      .where(and(eq(waitlists.venueId, venueId), eq(waitlists.status, "waiting")))
      .orderBy(asc(waitlists.requestedAt));

    const tableRows = await db
      .select({
        id: venueTables.id,
        label: venueTables.label,
        maxCover: venueTables.maxCover,
        areaName: areas.name,
      })
      .from(venueTables)
      .innerJoin(areas, eq(areas.id, venueTables.areaId))
      .where(eq(venueTables.venueId, venueId))
      .orderBy(asc(areas.name), asc(venueTables.label));

    const serviceRows = await db
      .select({ turnMinutes: services.turnMinutes })
      .from(services)
      .where(eq(services.venueId, venueId));

    // Average turn across services — fallback to 60 when no services
    // are set up (the seat-now path will error out, but the waitlist
    // page is still readable).
    const avg =
      serviceRows.length === 0
        ? 60
        : Math.round(serviceRows.reduce((acc, s) => acc + s.turnMinutes, 0) / serviceRows.length);

    return { entries: entryRows, tables: tableRows, avgTurnMinutes: avg };
  });

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-lg font-medium tracking-tight">Waitlist</h2>
        <p className="text-ash text-sm">
          Walk-ins waiting for a table. Add a new entry below; tap &ldquo;Seat now&rdquo; with a
          free table when one&apos;s ready and the guest gets an SMS. Estimated wait is position
          times average turn, capped at 90 min.
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
          Nobody waiting. Add a walk-in below.
        </p>
      ) : (
        <ul className="divide-hairline border-hairline divide-y rounded-md border">
          {entries.map((e, i) => (
            <WaitlistEntryRow
              key={e.id}
              entry={e}
              venueId={venueId}
              tables={tables}
              waitMinutes={estimateWaitMinutes({
                position: i + 1,
                avgTurnMinutes,
              })}
            />
          ))}
        </ul>
      )}

      <NewWalkInForm venueId={venueId} />
    </section>
  );
}
