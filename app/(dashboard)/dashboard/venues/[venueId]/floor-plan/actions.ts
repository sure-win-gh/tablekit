"use server";

import { and, eq, gte, lt, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { findSlots } from "@/lib/bookings/availability";
import { createBooking } from "@/lib/bookings/create";
import { todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { transitionBooking } from "@/lib/bookings/transition";
import {
  areas,
  bookingTables,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { ActionState } from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Resolve the target venue AND confirm it belongs to the caller's org.
// adminDb() bypasses RLS, so this explicit membership check is the gate.
async function assertVenueInOrg(venueId: string, orgId: string): Promise<void> {
  const rows = await adminDb()
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (rows.length === 0) {
    throw new Error("venue not found or not in your organisation");
  }
}

async function assertAreaInOrg(areaId: string, orgId: string): Promise<{ venueId: string }> {
  const rows = await adminDb()
    .select({ id: areas.id, venueId: areas.venueId })
    .from(areas)
    .where(and(eq(areas.id, areaId), eq(areas.organisationId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("area not found or not in your organisation");
  return { venueId: row.venueId };
}

async function assertTableInOrg(tableId: string, orgId: string): Promise<{ venueId: string }> {
  const rows = await adminDb()
    .select({ id: venueTables.id, venueId: venueTables.venueId })
    .from(venueTables)
    .where(and(eq(venueTables.id, tableId), eq(venueTables.organisationId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("table not found or not in your organisation");
  return { venueId: row.venueId };
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

const AreaCreateSchema = z.object({
  venueId: z.uuid(),
  name: z.string().min(1).max(60),
});

export async function createArea(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = AreaCreateSchema.safeParse({
    venueId: formData.get("venue_id"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { status: "error", message: "Area name is required." };

  const { orgId } = await requireRole("manager");
  await assertVenueInOrg(parsed.data.venueId, orgId);

  await adminDb().insert(areas).values({
    organisationId: orgId, // overwritten by enforce_areas_org_id trigger
    venueId: parsed.data.venueId,
    name: parsed.data.name,
  });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/floor-plan`);
  return { status: "saved" };
}

const AreaUpdateSchema = z.object({
  areaId: z.uuid(),
  name: z.string().min(1).max(60),
});

export async function updateArea(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = AreaUpdateSchema.safeParse({
    areaId: formData.get("area_id"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { status: "error", message: "Area name is required." };

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertAreaInOrg(parsed.data.areaId, orgId);

  await adminDb()
    .update(areas)
    .set({ name: parsed.data.name })
    .where(and(eq(areas.id, parsed.data.areaId), eq(areas.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

const AreaDeleteSchema = z.object({ areaId: z.uuid() });

export async function deleteArea(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = AreaDeleteSchema.safeParse({ areaId: formData.get("area_id") });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertAreaInOrg(parsed.data.areaId, orgId);

  await adminDb()
    .delete(areas)
    .where(and(eq(areas.id, parsed.data.areaId), eq(areas.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const TableCreateSchema = z
  .object({
    areaId: z.uuid(),
    label: z.string().min(1).max(30),
    minCover: z.coerce.number().int().min(1).max(40),
    maxCover: z.coerce.number().int().min(1).max(40),
    shape: z.enum(["rect", "circle"]),
    x: z.coerce.number().int().min(-100).max(100),
    y: z.coerce.number().int().min(-100).max(100),
    w: z.coerce.number().int().min(1).max(40),
    h: z.coerce.number().int().min(1).max(40),
  })
  .refine((d) => d.maxCover >= d.minCover, {
    message: "max_cover must be >= min_cover",
    path: ["maxCover"],
  });

export async function createTable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = TableCreateSchema.safeParse({
    areaId: formData.get("area_id"),
    label: formData.get("label"),
    minCover: formData.get("min_cover"),
    maxCover: formData.get("max_cover"),
    shape: formData.get("shape"),
    x: formData.get("x"),
    y: formData.get("y"),
    w: formData.get("w"),
    h: formData.get("h"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the table fields.",
    };
  }

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertAreaInOrg(parsed.data.areaId, orgId);

  const dup = await adminDb()
    .select({ id: venueTables.id })
    .from(venueTables)
    .where(
      and(
        eq(venueTables.organisationId, orgId),
        eq(venueTables.venueId, venueId),
        eq(venueTables.label, parsed.data.label),
      ),
    )
    .limit(1);
  if (dup.length > 0) {
    return {
      status: "error",
      message: `A table named "${parsed.data.label}" already exists in this venue.`,
    };
  }

  await adminDb()
    .insert(venueTables)
    .values({
      organisationId: orgId, // overwritten by the enforce_tables trigger
      venueId, // ditto
      areaId: parsed.data.areaId,
      label: parsed.data.label,
      minCover: parsed.data.minCover,
      maxCover: parsed.data.maxCover,
      shape: parsed.data.shape,
      position: {
        x: parsed.data.x,
        y: parsed.data.y,
        w: parsed.data.w,
        h: parsed.data.h,
      },
    });

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

const TableUpdateSchema = z
  .object({
    tableId: z.uuid(),
    label: z.string().min(1).max(30),
    minCover: z.coerce.number().int().min(1).max(40),
    maxCover: z.coerce.number().int().min(1).max(40),
    shape: z.enum(["rect", "circle"]),
    x: z.coerce.number().int().min(-100).max(100),
    y: z.coerce.number().int().min(-100).max(100),
    w: z.coerce.number().int().min(1).max(40),
    h: z.coerce.number().int().min(1).max(40),
  })
  .refine((d) => d.maxCover >= d.minCover, {
    message: "max_cover must be >= min_cover",
    path: ["maxCover"],
  });

export async function updateTable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = TableUpdateSchema.safeParse({
    tableId: formData.get("table_id"),
    label: formData.get("label"),
    minCover: formData.get("min_cover"),
    maxCover: formData.get("max_cover"),
    shape: formData.get("shape"),
    x: formData.get("x"),
    y: formData.get("y"),
    w: formData.get("w"),
    h: formData.get("h"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the table fields.",
    };
  }

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertTableInOrg(parsed.data.tableId, orgId);

  const dup = await adminDb()
    .select({ id: venueTables.id })
    .from(venueTables)
    .where(
      and(
        eq(venueTables.organisationId, orgId),
        eq(venueTables.venueId, venueId),
        eq(venueTables.label, parsed.data.label),
        ne(venueTables.id, parsed.data.tableId),
      ),
    )
    .limit(1);
  if (dup.length > 0) {
    return {
      status: "error",
      message: `A table named "${parsed.data.label}" already exists in this venue.`,
    };
  }

  await adminDb()
    .update(venueTables)
    .set({
      label: parsed.data.label,
      minCover: parsed.data.minCover,
      maxCover: parsed.data.maxCover,
      shape: parsed.data.shape,
      position: {
        x: parsed.data.x,
        y: parsed.data.y,
        w: parsed.data.w,
        h: parsed.data.h,
      },
    })
    .where(and(eq(venueTables.id, parsed.data.tableId), eq(venueTables.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

// Position-only update for the canvas drag-to-reposition flow.
// Separate from updateTable() so the canvas doesn't have to round-trip
// label/cover/shape on every drag-end.
const TablePositionSchema = z.object({
  tableId: z.uuid(),
  x: z.coerce.number().int().min(-100).max(100),
  y: z.coerce.number().int().min(-100).max(100),
  w: z.coerce.number().int().min(1).max(40),
  h: z.coerce.number().int().min(1).max(40),
});

export async function saveTablePosition(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = TablePositionSchema.safeParse({
    tableId: formData.get("table_id"),
    x: formData.get("x"),
    y: formData.get("y"),
    w: formData.get("w"),
    h: formData.get("h"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Bad position.",
    };
  }

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertTableInOrg(parsed.data.tableId, orgId);

  await adminDb()
    .update(venueTables)
    .set({
      position: {
        x: parsed.data.x,
        y: parsed.data.y,
        w: parsed.data.w,
        h: parsed.data.h,
      },
    })
    .where(and(eq(venueTables.id, parsed.data.tableId), eq(venueTables.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

const TableDeleteSchema = z.object({ tableId: z.uuid() });

export async function deleteTable(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = TableDeleteSchema.safeParse({ tableId: formData.get("table_id") });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertTableInOrg(parsed.data.tableId, orgId);

  await adminDb()
    .delete(venueTables)
    .where(and(eq(venueTables.id, parsed.data.tableId), eq(venueTables.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/floor-plan`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Walk-in
// ---------------------------------------------------------------------------

// Resolve "right-now" to a real slot/service the booking engine accepts.
// We pull today's full slot grid, narrow it to slots whose options include
// the target table, and pick the one closest to `now`. If nothing fits
// (table fully booked, venue closed) we hand the slot-engine error back to
// the operator.
const WalkInSchema = z.object({
  venueId: z.uuid(),
  tableId: z.uuid(),
  partySize: z.coerce.number().int().min(1).max(20),
});

export async function seatWalkIn(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = WalkInSchema.safeParse({
    venueId: formData.get("venue_id"),
    tableId: formData.get("table_id"),
    partySize: formData.get("party_size"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Bad request." };
  }

  const auth = await requireRole("host");
  const { orgId, userId } = auth;
  await assertVenueInOrg(parsed.data.venueId, orgId);
  const { venueId: tableVenueId } = await assertTableInOrg(parsed.data.tableId, orgId);
  if (tableVenueId !== parsed.data.venueId) {
    return { status: "error", message: "Table doesn't belong to this venue." };
  }

  const db = adminDb();
  const [venue] = await db
    .select({ id: venues.id, timezone: venues.timezone })
    .from(venues)
    .where(eq(venues.id, parsed.data.venueId))
    .limit(1);
  if (!venue) return { status: "error", message: "Venue not found." };

  const date = todayInZone(venue.timezone);
  const { startUtc, endUtc } = venueLocalDayRange(date, venue.timezone);

  const [venueServices, venueTablesRows, occupied] = await Promise.all([
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
  ]);

  const slots = findSlots({
    timezone: venue.timezone,
    date,
    partySize: parsed.data.partySize,
    services: venueServices.map((s) => ({
      id: s.id,
      name: s.name,
      schedule: s.schedule as { days: never; start: string; end: string },
      turnMinutes: s.turnMinutes,
    })),
    tables: venueTablesRows,
    occupied,
  });

  // Filter to slots that can seat this party on the requested table
  // (table appears in one of the slot's options).
  const eligible = slots.filter((s) =>
    s.options.some((o) => o.tableIds.includes(parsed.data.tableId)),
  );
  if (eligible.length === 0) {
    return {
      status: "error",
      message: "No service is open for that party size on this table right now.",
    };
  }

  // Pick the slot closest to now — walk-ins should be seated against
  // the currently-running service slot, not later in the day.
  const nowMs = Date.now();
  eligible.sort(
    (a, b) => Math.abs(a.startAt.getTime() - nowMs) - Math.abs(b.startAt.getTime() - nowMs),
  );
  const slot = eligible[0]!;

  // Find-or-create the walk-in placeholder guest for this venue.
  // upsertGuest collides on email-hash and returns the existing row,
  // so every walk-in at this venue reuses the same guest record — that
  // is intentional, not a bug. We want zero guest-table residue from
  // anonymous walk-ins and zero accidental cross-linking across visits.
  //
  // TODO(walkin-messaging): when guest-facing email/SMS automation
  // ships, the dispatch worker MUST skip the `@walkin.tablekit.local`
  // domain (see lib/messaging/load-context.ts). gdpr-auditor flagged.
  const walkInEmail = `walkin+${venue.id}@walkin.tablekit.local`;

  const result = await createBooking(orgId, userId, {
    venueId: venue.id,
    serviceId: slot.serviceId,
    date,
    wallStart: slot.wallStart,
    partySize: parsed.data.partySize,
    guest: { firstName: "Walk-in", email: walkInEmail },
    source: "host",
    preferredTableIds: [parsed.data.tableId],
  });

  if (!result.ok) {
    const message =
      result.reason === "slot-taken"
        ? "That table just got booked elsewhere — refresh and try again."
        : result.reason === "no-availability"
          ? "No availability on that table right now."
          : result.reason === "guest-invalid"
            ? "Couldn't create the walk-in guest record."
            : "Couldn't seat walk-in.";
    return { status: "error", message };
  }

  // Immediately seat — that's the whole point of "walk-in".
  const transition = await transitionBooking(orgId, userId, result.bookingId, "seated");
  if (!transition.ok) {
    // Booking exists as confirmed; the host can still seat manually
    // from the bookings list. Surface a soft error.
    revalidatePath(`/dashboard/venues/${venue.id}/floor-plan`);
    return {
      status: "error",
      message: "Created the booking but couldn't mark it seated. Seat manually from bookings.",
    };
  }

  revalidatePath(`/dashboard/venues/${venue.id}/floor-plan`);
  revalidatePath(`/dashboard/venues/${venue.id}/bookings`);
  return { status: "saved" };
}
