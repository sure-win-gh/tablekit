"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { areas, services, venueTables, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";
import { templates } from "@/lib/venues/templates";

const Schema = z.object({
  name: z.string().min(1, "Required").max(120),
  venueType: z.enum(["cafe", "restaurant", "bar_pub"]),
  timezone: z.string().min(1).max(60),
  locale: z.string().min(1).max(20),
});

export type CreateVenueState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[]> };

export async function createVenue(
  _prev: CreateVenueState,
  formData: FormData,
): Promise<CreateVenueState> {
  const parsed = Schema.safeParse({
    name: formData.get("name"),
    venueType: formData.get("venue_type"),
    timezone: formData.get("timezone") || "Europe/London",
    locale: formData.get("locale") || "en-GB",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { orgId, userId } = await requireRole("manager");
  const { name, venueType, timezone, locale } = parsed.data;
  const template = templates[venueType];

  // Atomic: venue + every area/table/service from the template land
  // together, or nothing does. adminDb() bypasses RLS so we can seed
  // child rows the user can't yet "see" (they pass RLS right after
  // the venue.organisation_id cascade is in place).
  const venueId = await adminDb().transaction(async (tx) => {
    const [venueRow] = await tx
      .insert(venues)
      .values({ organisationId: orgId, name, venueType, timezone, locale })
      .returning({ id: venues.id });
    if (!venueRow) throw new Error("createVenue: venue insert returned no row");

    for (const area of template.areas) {
      const [areaRow] = await tx
        .insert(areas)
        .values({
          // organisation_id is overwritten by the enforce_areas_org_id
          // trigger — passed here only to satisfy the notNull TS type.
          organisationId: orgId,
          venueId: venueRow.id,
          name: area.name,
        })
        .returning({ id: areas.id });
      if (!areaRow) throw new Error("createVenue: area insert returned no row");

      for (const table of area.tables) {
        // organisation_id + venue_id are both overwritten by the
        // enforce_tables_org_and_venue trigger.
        await tx.insert(venueTables).values({
          organisationId: orgId,
          venueId: venueRow.id,
          areaId: areaRow.id,
          label: table.label,
          minCover: table.minCover,
          maxCover: table.maxCover,
          position: table.position,
        });
      }
    }

    for (const service of template.services) {
      await tx.insert(services).values({
        organisationId: orgId,
        venueId: venueRow.id,
        name: service.name,
        schedule: service.schedule,
        turnMinutes: service.turnMinutes,
      });
    }

    return venueRow.id;
  });

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.created",
    targetType: "venue",
    targetId: venueId,
    metadata: { venueType, name, timezone, locale },
  });

  redirect(`/dashboard/venues/${venueId}/floor-plan`);
}
