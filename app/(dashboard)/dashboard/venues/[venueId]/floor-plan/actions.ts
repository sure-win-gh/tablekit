"use server";

import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { findSlots } from "@/lib/bookings/availability";
import { loadVenueCombining } from "@/lib/bookings/combinable";
import { createBooking } from "@/lib/bookings/create";
import { todayInZone, venueLocalDayRange } from "@/lib/bookings/time";
import { transitionBooking } from "@/lib/bookings/transition";
import {
  areas,
  bookingTables,
  services,
  tableCombinations,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { MAX_TABLES_MAX, MAX_TABLES_MIN } from "@/lib/venues/table-combining";

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

const AreaAvailabilitySchema = z.object({
  areaId: z.uuid(),
  bookable: z.boolean(),
  closedMonths: z
    .array(z.coerce.number().int())
    .max(12)
    .refine((arr) => arr.every((m) => m >= 1 && m <= 12), { message: "Months must be 1–12" }),
});

// Area availability (docs/specs/area-preferences.md): the weather kill
// switch + seasonal closed months. Blocks NEW standard bookings only —
// existing bookings in the area are never auto-cancelled.
export async function updateAreaAvailability(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = AreaAvailabilitySchema.safeParse({
    areaId: formData.get("area_id"),
    bookable: formData.get("bookable") === "on",
    closedMonths: formData.getAll("closed_months").map(String),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertAreaInOrg(parsed.data.areaId, orgId);

  await adminDb()
    .update(areas)
    .set({ bookable: parsed.data.bookable, closedMonths: parsed.data.closedMonths })
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

  try {
    await adminDb()
      .delete(areas)
      .where(and(eq(areas.id, parsed.data.areaId), eq(areas.organisationId, orgId)));
  } catch (err) {
    // 23503 foreign_key_violation — the area is referenced by bookings or a
    // special event's area scope (special_event_areas is NO ACTION on
    // purpose; deleting a scoped area must not silently widen the block to
    // the whole venue — spec §Area-scoped events).
    const code = (err as { code?: unknown }).code;
    const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
    if (code === "23503" || causeCode === "23503") {
      return {
        status: "error",
        message:
          "This area is referenced by bookings or a special event — move those (or edit the event's area scope) first.",
      };
    }
    throw err;
  }

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
// Table joins (operator-set combinations — docs/specs/table-combining.md)
// ---------------------------------------------------------------------------

const TableCombinationSchema = z.object({
  tableAId: z.uuid(),
  tableBId: z.uuid(),
});

// Toggle a "these two tables can be pushed together" edge. Symmetric —
// the pair is canonicalised (lo < hi) so {A,B} has exactly one row. Both
// tables must be in the caller's org, the same venue, and the same area
// (a combined booking stays single-area). Creating if absent, removing if
// present, so a single tap in the floor-plan join mode flips the join.
export async function toggleTableCombination(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = TableCombinationSchema.safeParse({
    tableAId: formData.get("table_a_id"),
    tableBId: formData.get("table_b_id"),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };
  // Normalise to lowercase so JS string ordering agrees with Postgres'
  // uuid ordering (the table_a_id < table_b_id CHECK) — z.uuid() accepts
  // upper-case input but stored uuids are lower-case.
  const tableAId = parsed.data.tableAId.toLowerCase();
  const tableBId = parsed.data.tableBId.toLowerCase();
  if (tableAId === tableBId) return { status: "error", message: "Pick two different tables." };

  const { orgId } = await requireRole("manager");

  const rows = await adminDb()
    .select({ id: venueTables.id, venueId: venueTables.venueId, areaId: venueTables.areaId })
    .from(venueTables)
    .where(
      and(eq(venueTables.organisationId, orgId), inArray(venueTables.id, [tableAId, tableBId])),
    );
  if (rows.length !== 2) {
    return { status: "error", message: "Table not found or not in your organisation." };
  }
  const [r1, r2] = rows as [(typeof rows)[number], (typeof rows)[number]];
  if (r1.venueId !== r2.venueId) {
    return { status: "error", message: "Tables must be in the same venue." };
  }
  if (r1.areaId !== r2.areaId) {
    return { status: "error", message: "You can only join tables in the same area." };
  }

  const [lo, hi] = tableAId < tableBId ? [tableAId, tableBId] : [tableBId, tableAId];
  const existing = await adminDb()
    .select({ id: tableCombinations.id })
    .from(tableCombinations)
    .where(and(eq(tableCombinations.tableAId, lo), eq(tableCombinations.tableBId, hi)))
    .limit(1);

  if (existing.length > 0) {
    await adminDb().delete(tableCombinations).where(eq(tableCombinations.id, existing[0]!.id));
  } else {
    // onConflictDoNothing guards a double-tap race where two concurrent
    // "not exists" reads both try to insert the same pair — the unique
    // (table_a_id, table_b_id) index would otherwise raise a raw 23505.
    await adminDb()
      .insert(tableCombinations)
      .values({
        organisationId: orgId, // overwritten by enforce_table_combinations_denorm
        venueId: r1.venueId, // ditto
        areaId: r1.areaId, // ditto
        tableAId: lo,
        tableBId: hi,
      })
      .onConflictDoNothing();
  }

  revalidatePath(`/dashboard/venues/${r1.venueId}/floor-plan`);
  return { status: "saved" };
}

const MaxCombineSchema = z.object({
  venueId: z.uuid(),
  maxTables: z.coerce.number().int().min(MAX_TABLES_MIN).max(MAX_TABLES_MAX),
});

// Set the venue's "most tables you'd ever push together" cap. Merged into
// venues.settings.tableCombining without clobbering sibling keys.
export async function setVenueMaxCombineTables(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = MaxCombineSchema.safeParse({
    venueId: formData.get("venue_id"),
    maxTables: formData.get("max_tables"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: `Pick a number between ${MAX_TABLES_MIN} and ${MAX_TABLES_MAX}.`,
    };
  }

  const { orgId } = await requireRole("manager");
  await assertVenueInOrg(parsed.data.venueId, orgId);

  const [row] = await adminDb()
    .select({ settings: venues.settings })
    .from(venues)
    .where(eq(venues.id, parsed.data.venueId))
    .limit(1);
  const current = (row?.settings as Record<string, unknown>) ?? {};
  const currentCombining = (current["tableCombining"] as Record<string, unknown>) ?? {};
  const merged = {
    ...current,
    tableCombining: { ...currentCombining, maxTables: parsed.data.maxTables },
  };

  await adminDb()
    .update(venues)
    .set({ settings: merged })
    .where(and(eq(venues.id, parsed.data.venueId), eq(venues.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/floor-plan`);
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

export async function seatWalkIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
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

  const { combinable, maxCombineTables } = await loadVenueCombining(db, venue.id);
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
    combinable,
    maxCombineTables,
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
