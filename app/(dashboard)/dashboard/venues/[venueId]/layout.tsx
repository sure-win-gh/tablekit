import { asc, eq } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { VenueSwitcher } from "@/components/venue-switcher";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

// Shared chrome for every route under /dashboard/venues/[venueId]:
// venue name as h1 and a breadcrumb. The per-venue tab nav moved
// into the dashboard sidebar (app/(dashboard)/sidebar-shell.tsx);
// the org-level pills (Organisation, Privacy requests) live there
// too. The VenueSwitcher pill stays inline so ⌘K hint discovery is
// adjacent to the venue name.
//
// If the venue id doesn't resolve for the current user (wrong org,
// deleted, bad id), we 404 here so the rest of the subtree never
// has to handle the "what if it's gone" case.

export default async function VenueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ venueId: string }>;
}) {
  await requireRole("host");
  const { venueId } = await params;

  const { venue, siblings } = await withUser(async (db) => {
    const [v] = await db
      .select({ id: venues.id, name: venues.name, organisationId: venues.organisationId })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    if (!v) return { venue: null, siblings: [] as Array<{ id: string; name: string }> };
    const all = await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.organisationId, v.organisationId))
      .orderBy(asc(venues.name));
    return { venue: v, siblings: all };
  });

  if (!venue) notFound();

  return (
    <div className="flex flex-1 flex-col py-6">
      <nav className="flex items-center justify-between gap-1.5 text-xs text-ash">
        <div className="flex items-center gap-1.5">
          <Link href="/dashboard/venues" className="hover:text-ink">
            Venues
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
          <span className="text-ink">{venue.name}</span>
        </div>
        <VenueSwitcher currentVenueId={venue.id} venues={siblings} />
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{venue.name}</h1>
      </header>

      <div className="mt-6">{children}</div>
    </div>
  );
}
