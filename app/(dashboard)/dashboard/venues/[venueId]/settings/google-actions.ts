"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venueOauthConnections, venues } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const Schema = z.object({ venueId: z.uuid() });

export type DisconnectGoogleState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function disconnectGoogle(
  _prev: DisconnectGoogleState,
  formData: FormData,
): Promise<DisconnectGoogleState> {
  const parsed = Schema.safeParse({ venueId: formData.get("venue_id") });
  if (!parsed.success) return { status: "error", message: "Invalid request." };

  const { orgId, userId } = await requireRole("manager");
  const { venueId } = parsed.data;

  // Per-venue scope check via RLS (matches the pattern in
  // reviews/actions.ts). Without this, a manager scoped to one venue
  // could disconnect another venue's connection in the same org.
  const visible = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows.length > 0;
  });
  if (!visible) return { status: "error", message: "Venue not found." };

  const db = adminDb();
  await db
    .delete(venueOauthConnections)
    .where(
      and(
        eq(venueOauthConnections.venueId, venueId),
        eq(venueOauthConnections.organisationId, orgId),
        eq(venueOauthConnections.provider, "google"),
      ),
    );

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "oauth.disconnected",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "google" },
  });

  revalidatePath(`/dashboard/venues/${venueId}/settings`);
  return { status: "saved" };
}
