"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { services, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

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

async function assertServiceInOrg(serviceId: string, orgId: string): Promise<{ venueId: string }> {
  const rows = await adminDb()
    .select({ id: services.id, venueId: services.venueId })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organisationId, orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("service not found or not in your organisation");
  return { venueId: row.venueId };
}

const ServiceBody = z
  .object({
    name: z.string().min(1).max(60),
    days: z.array(z.enum(DAYS)).min(1, "Pick at least one day"),
    start: z.string().regex(TIME_RE, "Use HH:MM"),
    end: z.string().regex(TIME_RE, "Use HH:MM"),
    turnMinutes: z.coerce.number().int().min(15).max(480),
  })
  .refine((d) => d.start < d.end, {
    message: "End must be later than start.",
    path: ["end"],
  });

function readBody(formData: FormData) {
  return {
    name: formData.get("name"),
    // formData.getAll returns all values for the name — use for checkboxes.
    days: formData.getAll("days"),
    start: formData.get("start"),
    end: formData.get("end"),
    turnMinutes: formData.get("turn_minutes"),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const ServiceCreateSchema = ServiceBody.and(z.object({ venueId: z.uuid() }));

export async function createService(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ServiceCreateSchema.safeParse({
    venueId: formData.get("venue_id"),
    ...readBody(formData),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the service fields.",
    };
  }

  const { orgId } = await requireRole("manager");
  await assertVenueInOrg(parsed.data.venueId, orgId);

  await adminDb()
    .insert(services)
    .values({
      organisationId: orgId, // overwritten by enforce_services_org_id trigger
      venueId: parsed.data.venueId,
      name: parsed.data.name,
      schedule: {
        days: parsed.data.days,
        start: parsed.data.start,
        end: parsed.data.end,
      },
      turnMinutes: parsed.data.turnMinutes,
    });

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/services`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const ServiceUpdateSchema = ServiceBody.and(z.object({ serviceId: z.uuid() }));

export async function updateService(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ServiceUpdateSchema.safeParse({
    serviceId: formData.get("service_id"),
    ...readBody(formData),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the service fields.",
    };
  }

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertServiceInOrg(parsed.data.serviceId, orgId);

  await adminDb()
    .update(services)
    .set({
      name: parsed.data.name,
      schedule: {
        days: parsed.data.days,
        start: parsed.data.start,
        end: parsed.data.end,
      },
      turnMinutes: parsed.data.turnMinutes,
    })
    .where(and(eq(services.id, parsed.data.serviceId), eq(services.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/services`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const ServiceDeleteSchema = z.object({ serviceId: z.uuid() });

export async function deleteService(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ServiceDeleteSchema.safeParse({ serviceId: formData.get("service_id") });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId } = await requireRole("manager");
  const { venueId } = await assertServiceInOrg(parsed.data.serviceId, orgId);

  await adminDb()
    .delete(services)
    .where(and(eq(services.id, parsed.data.serviceId), eq(services.organisationId, orgId)));

  revalidatePath(`/dashboard/venues/${venueId}/services`);
  return { status: "saved" };
}
