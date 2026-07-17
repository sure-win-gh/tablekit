import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import {
  areas,
  bookings,
  eventTicketTypes,
  guests,
  specialEventAreas,
  specialEvents,
  venues,
  venueTables,
} from "@/lib/db/schema";

import { NewTicketTypeForm, TicketTypeRow } from "./ticket-forms";

export const metadata = {
  title: "Event · TableKit",
};

const STATUS_LABEL: Record<string, string> = {
  requested: "Pending payment",
  confirmed: "Confirmed",
  seated: "Seated",
  finished: "Finished",
  no_show: "No-show",
};

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ venueId: string; eventId: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const plan = await getPlan(orgId);
  if (isLocked(plan, "events")) {
    return <LockedFeature feature="events" currentPlan={plan} />;
  }
  const { venueId, eventId } = await params;

  const data = await withUser(async (db) => {
    const [event] = await db
      .select({
        id: specialEvents.id,
        name: specialEvents.name,
        status: specialEvents.status,
        startsAt: specialEvents.startsAt,
        endsAt: specialEvents.endsAt,
        blockScope: specialEvents.blockScope,
        venueId: specialEvents.venueId,
      })
      .from(specialEvents)
      .where(and(eq(specialEvents.id, eventId), eq(specialEvents.venueId, venueId)))
      .limit(1);
    if (!event) return null;

    const [venue] = await db
      .select({ timezone: venues.timezone })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    const types = await db
      .select({
        id: eventTicketTypes.id,
        name: eventTicketTypes.name,
        priceMinor: eventTicketTypes.priceMinor,
        quantityTotal: eventTicketTypes.quantityTotal,
        quantitySold: eventTicketTypes.quantitySold,
        maxPerOrder: eventTicketTypes.maxPerOrder,
      })
      .from(eventTicketTypes)
      .where(eq(eventTicketTypes.eventId, eventId))
      .orderBy(asc(eventTicketTypes.sort), asc(eventTicketTypes.createdAt));

    // Area scope (empty = whole venue) + a covers hint for ticket capacity:
    // the scoped areas' total max covers. A hint only — never enforcement
    // (spec §Tickets stay GA).
    const scopeRows = await db
      .select({ areaId: specialEventAreas.areaId, name: areas.name })
      .from(specialEventAreas)
      .innerJoin(areas, eq(areas.id, specialEventAreas.areaId))
      .where(eq(specialEventAreas.eventId, eventId))
      .orderBy(asc(areas.sort), asc(areas.name));
    let coversHint: number | null = null;
    if (scopeRows.length > 0) {
      const tables = await db
        .select({ maxCover: venueTables.maxCover })
        .from(venueTables)
        .where(
          inArray(
            venueTables.areaId,
            scopeRows.map((s) => s.areaId),
          ),
        );
      coversHint = tables.reduce((n, t) => n + t.maxCover, 0);
    }

    // Attendees — every non-cancelled event booking. first_name is plaintext
    // (only last name / contact details are encrypted), so a door list needs
    // no decryption.
    const attendees = await db
      .select({
        id: bookings.id,
        firstName: guests.firstName,
        partySize: bookings.partySize,
        status: bookings.status,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .innerJoin(guests, eq(guests.id, bookings.guestId))
      .where(and(eq(bookings.eventId, eventId), ne(bookings.status, "cancelled")))
      .orderBy(desc(bookings.createdAt));

    return {
      event,
      timezone: venue?.timezone ?? "Europe/London",
      types,
      attendees,
      scopeNames: scopeRows.map((s) => s.name),
      coversHint,
    };
  });

  if (!data) notFound();
  const { event, timezone, types, attendees, scopeNames, coversHint } = data;

  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(event.startsAt);
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  const timeLabel =
    event.blockScope === "whole_day"
      ? "All day"
      : `${timeFmt.format(event.startsAt)}–${timeFmt.format(event.endsAt)}`;

  const soldTickets = attendees
    .filter((a) => a.status !== "no_show" && a.status !== "requested")
    .reduce((n, a) => n + a.partySize, 0);

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href={`/dashboard/venues/${venueId}/events`}
          className="text-ash hover:text-ink text-sm font-medium"
        >
          ← All events
        </Link>
        <h2 className="text-ink mt-2 text-xl font-bold tracking-tight">{event.name}</h2>
        <p className="text-ash mt-0.5 text-sm">
          {dateLabel} · {timeLabel} · {event.status}
          {scopeNames.length > 0 ? ` · ${scopeNames.join(" + ")} only` : ""}
        </p>
      </div>

      {event.status !== "published" ? (
        <p className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This event is a <strong>{event.status}</strong> — publish it (on the events list) to open
          ticket sales and close the date to standard bookings.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-ink text-sm font-bold tracking-tight">Ticket types</h3>
        {types.length === 0 ? (
          <p className="border-hairline text-ash rounded-card border border-dashed bg-white p-6 text-center text-sm">
            No ticket types yet — add one below to start selling.
          </p>
        ) : (
          <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
            {types.map((t) => (
              <TicketTypeRow key={t.id} type={t} eventId={eventId} venueId={venueId} />
            ))}
          </div>
        )}
        <NewTicketTypeForm
          eventId={eventId}
          venueId={venueId}
          startOpen={types.length === 0}
          coversHint={coversHint}
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-ink text-sm font-bold tracking-tight">
          Attendees{" "}
          <span className="text-ash font-normal">
            ({soldTickets} ticket{soldTickets === 1 ? "" : "s"} sold)
          </span>
        </h3>
        {attendees.length === 0 ? (
          <p className="border-hairline text-ash rounded-card border border-dashed bg-white p-6 text-center text-sm">
            No bookings yet.
          </p>
        ) : (
          <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
            {attendees.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="text-ink min-w-0 flex-1 truncate font-medium">{a.firstName}</span>
                <span className="text-ash tabular-nums">
                  {a.partySize} ticket{a.partySize === 1 ? "" : "s"}
                </span>
                <span className="text-ash text-xs">{STATUS_LABEL[a.status] ?? a.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
