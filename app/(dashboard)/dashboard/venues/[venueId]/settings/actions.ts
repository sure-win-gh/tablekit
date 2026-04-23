"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

const Schema = z.object({
  venueId: z.uuid(),
  name: z.string().min(1, "Required").max(120),
  timezone: z.string().min(1).max(60),
  locale: z.string().min(1).max(20),
});

export type UpdateVenueState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> }
  | { status: "saved" };

export async function updateVenue(
  _prev: UpdateVenueState,
  formData: FormData,
): Promise<UpdateVenueState> {
  const parsed = Schema.safeParse({
    venueId: formData.get("venue_id"),
    name: formData.get("name"),
    timezone: formData.get("timezone"),
    locale: formData.get("locale"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { orgId, userId } = await requireRole("manager");
  const { venueId, name, timezone, locale } = parsed.data;

  // The `and(org_id = orgId)` in the WHERE is what stops a managed
  // user from poking another org's venue with a crafted venueId —
  // adminDb() bypasses RLS, so this check carries the weight.
  const [updated] = await adminDb()
    .update(venues)
    .set({ name, timezone, locale })
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .returning({ id: venues.id });

  if (!updated) {
    return {
      status: "error",
      message: "Venue not found or not in your organisation.",
    };
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.updated",
    targetType: "venue",
    targetId: updated.id,
    metadata: { name, timezone, locale },
  });

  revalidatePath(`/dashboard/venues/${updated.id}`, "layout");
  return { status: "saved" };
}
