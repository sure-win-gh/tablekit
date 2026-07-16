"use server";

import { and, count, eq, gt, lt, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { slugify } from "@/lib/auth/slug";
import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { venueLocalDayRange, zonedWallToUtc } from "@/lib/bookings/time";
import { bookings, specialEvents, venues } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { ActionState } from "./types";

// Resolve the venue (scoped to the caller's org) and hand back its
// timezone — event windows are stored in UTC but authored in venue-local
// wall time, so every write needs the zone. Throws if the venue isn't in
// the org (defensive; the page already scopes by venue).
async function venueTimezone(venueId: string, orgId: string): Promise<string> {
  const [row] = await adminDb()
    .select({ timezone: venues.timezone })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!row) throw new Error("venue not found or not in your organisation");
  return row.timezone;
}

// Count live standard bookings whose window overlaps [startsAt, endsAt) — the
// ones an operator should review when they publish an event over that date.
// We never auto-cancel (spec: Date blocking §existing bookings); this just
// powers a non-blocking warning.
async function countCollidingBookings(
  venueId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<number> {
  const [row] = await adminDb()
    .select({ n: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, venueId),
        notInArray(bookings.status, ["cancelled", "no_show"]),
        lt(bookings.startAt, endsAt),
        gt(bookings.endAt, startsAt),
      ),
    );
  return row?.n ?? 0;
}

function collisionWarning(n: number): string | undefined {
  if (n <= 0) return undefined;
  const one = n === 1;
  return `${n} existing booking${one ? "" : "s"} fall inside this event's window and ${
    one ? "was" : "were"
  } not cancelled — review ${one ? "it" : "them"} in Bookings.`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const CreateBody = z
  .object({
    venueId: z.uuid(),
    name: z.string().trim().min(2, "Give the event a name").max(120),
    description: z
      .string()
      .trim()
      .max(4000)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
    scope: z.enum(["window", "whole_day"]),
    // Only used for scope=window; validated below.
    startTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    endTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    publish: z.boolean().default(false),
    externalTicketUrl: z
      .string()
      .trim()
      .url("Ticket link must be a valid URL")
      .refine((v) => v.startsWith("https://"), "Ticket link must start with https://")
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((d) => d.scope !== "window" || (d.startTime && d.endTime), {
    message: "Set a start and end time, or choose 'Whole day'.",
    path: ["startTime"],
  });

export async function createSpecialEvent(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = CreateBody.safeParse({
    venueId: formData.get("venue_id"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    date: formData.get("date"),
    scope: formData.get("scope"),
    startTime: formData.get("start_time") || undefined,
    endTime: formData.get("end_time") || undefined,
    publish: formData.get("publish") === "on",
    externalTicketUrl: formData.get("external_ticket_url") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the fields." };
  }

  // Plus-gated: the page renders a LockedFeature for non-Plus orgs, but the
  // action re-asserts so a crafted request can't create events. Throws
  // InsufficientPlanError (surfaces in Sentry) — same posture as the spec.
  const { orgId, userId } = await requireRole("manager");
  await requirePlan(orgId, "plus");
  const tz = await venueTimezone(parsed.data.venueId, orgId);

  // Resolve the concrete UTC window. A whole-day event is stored as the full
  // venue-local day [midnight, next-midnight) so the availability loaders can
  // treat the stored window as authoritative with no timezone maths.
  let startsAt: Date;
  let endsAt: Date;
  if (parsed.data.scope === "whole_day") {
    const range = venueLocalDayRange(parsed.data.date, tz);
    startsAt = range.startUtc;
    endsAt = range.endUtc;
  } else {
    startsAt = zonedWallToUtc(parsed.data.date, parsed.data.startTime!, tz);
    endsAt = zonedWallToUtc(parsed.data.date, parsed.data.endTime!, tz);
    if (endsAt.getTime() <= startsAt.getTime()) {
      return { status: "error", message: "End time must be after the start time." };
    }
  }

  const slug = `${slugify(parsed.data.name) || "event"}-${crypto.randomUUID().slice(0, 4)}`;

  const values: typeof specialEvents.$inferInsert = {
    organisationId: orgId,
    venueId: parsed.data.venueId,
    slug,
    name: parsed.data.name,
    startsAt,
    endsAt,
    status: parsed.data.publish ? "published" : "draft",
    // Phase 1 events always block standard bookings (that's the point). A
    // non-blocking variant is modelled but not surfaced yet.
    blocksStandardBookings: true,
    blockScope: parsed.data.scope,
  };
  if (parsed.data.description) values.description = parsed.data.description;
  if (parsed.data.externalTicketUrl) values.externalTicketUrl = parsed.data.externalTicketUrl;

  const [inserted] = await adminDb()
    .insert(specialEvents)
    .values(values)
    .returning({ id: specialEvents.id });

  if (inserted) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "special_event.created",
      targetType: "special_event",
      targetId: inserted.id,
      metadata: {
        venueId: parsed.data.venueId,
        status: values.status,
        scope: parsed.data.scope,
      },
    });
  }

  // Publishing closes the date to standard bookings — flag any that already
  // exist so the operator can move/cancel them (never auto-cancelled).
  const warning =
    values.status === "published"
      ? collisionWarning(await countCollidingBookings(parsed.data.venueId, startsAt, endsAt))
      : undefined;

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/events`);
  return warning ? { status: "saved", warning } : { status: "saved" };
}

// ---------------------------------------------------------------------------
// Set status (publish / unpublish / cancel)
// ---------------------------------------------------------------------------

const StatusBody = z.object({
  eventId: z.uuid(),
  venueId: z.uuid(),
  status: z.enum(["draft", "published", "cancelled"]),
});

export async function setSpecialEventStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = StatusBody.safeParse({
    eventId: formData.get("event_id"),
    venueId: formData.get("venue_id"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId, userId } = await requireRole("manager");
  await requirePlan(orgId, "plus");

  const updated = await adminDb()
    .update(specialEvents)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(and(eq(specialEvents.id, parsed.data.eventId), eq(specialEvents.organisationId, orgId)))
    .returning({
      id: specialEvents.id,
      venueId: specialEvents.venueId,
      startsAt: specialEvents.startsAt,
      endsAt: specialEvents.endsAt,
    });

  const row = updated[0];
  if (row) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "special_event.status_changed",
      targetType: "special_event",
      targetId: parsed.data.eventId,
      metadata: { venueId: parsed.data.venueId, status: parsed.data.status },
    });
  }

  // Same collision notice as create, when a publish closes the date.
  const warning =
    parsed.data.status === "published" && row
      ? collisionWarning(await countCollidingBookings(row.venueId, row.startsAt, row.endsAt))
      : undefined;

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/events`);
  return warning ? { status: "saved", warning } : { status: "saved" };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const DeleteBody = z.object({ eventId: z.uuid(), venueId: z.uuid() });

export async function deleteSpecialEvent(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = DeleteBody.safeParse({
    eventId: formData.get("event_id"),
    venueId: formData.get("venue_id"),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId, userId } = await requireRole("manager");
  await requirePlan(orgId, "plus");

  const deleted = await adminDb()
    .delete(specialEvents)
    .where(and(eq(specialEvents.id, parsed.data.eventId), eq(specialEvents.organisationId, orgId)))
    .returning({ id: specialEvents.id });

  if (deleted.length > 0) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "special_event.deleted",
      targetType: "special_event",
      targetId: parsed.data.eventId,
      metadata: { venueId: parsed.data.venueId },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/events`);
  return { status: "saved" };
}
