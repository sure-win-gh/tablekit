import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

import { VenueSettingsForm } from "./form";

export const metadata = {
  title: "Settings · TableKit",
};

export default async function VenueSettingsPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  await requireRole("manager");
  const { venueId } = await params;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        venueType: venues.venueType,
        timezone: venues.timezone,
        locale: venues.locale,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  return (
    <section>
      <p className="mb-6 text-sm text-neutral-500">
        Venue type is <span className="font-mono text-neutral-700">{venue.venueType}</span> —
        changing type isn&apos;t supported yet.
      </p>

      <VenueSettingsForm
        venueId={venue.id}
        name={venue.name}
        timezone={venue.timezone}
        locale={venue.locale}
      />
    </section>
  );
}
