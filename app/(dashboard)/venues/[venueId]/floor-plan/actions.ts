"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { areas, venueTables, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

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

type ActionState = { status: "idle" } | { status: "error"; message: string } | { status: "saved" };

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
    x: z.coerce.number().int().min(0).max(100),
    y: z.coerce.number().int().min(0).max(100),
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
    x: z.coerce.number().int().min(0).max(100),
    y: z.coerce.number().int().min(0).max(100),
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

// Re-export ActionState so client components can type their useActionState.
export type { ActionState };
