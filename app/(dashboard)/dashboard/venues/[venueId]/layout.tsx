import { eq } from "drizzle-orm";
import { ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

import { VenueTabs } from "./nav-tabs";

// Shared chrome for every route under /dashboard/venues/[venueId]:
// venue name as h1, breadcrumb, and a tab nav across the venue's
// surfaces. If the venue id doesn't resolve for the current user
// (wrong org, deleted, bad id), we 404 here so the rest of the
// subtree never has to handle the "what if it's gone" case.

export default async function VenueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ venueId: string }>;
}) {
  await requireRole("host");
  const { venueId } = await params;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });

  if (!venue) notFound();

  const tabs = [
    { href: `/dashboard/venues/${venue.id}/floor-plan`, label: "Floor plan" },
    { href: `/dashboard/venues/${venue.id}/bookings`, label: "Bookings" },
    { href: `/dashboard/venues/${venue.id}/waitlist`, label: "Waitlist" },
    { href: `/dashboard/venues/${venue.id}/services`, label: "Services" },
    { href: `/dashboard/venues/${venue.id}/deposits`, label: "Deposits" },
    { href: `/dashboard/venues/${venue.id}/reports`, label: "Reports" },
    { href: `/dashboard/venues/${venue.id}/settings`, label: "Settings" },
  ];

  return (
    <div className="flex flex-1 flex-col p-6">
      <nav className="flex items-center justify-between gap-1.5 text-xs text-ash">
        <div className="flex items-center gap-1.5">
          <Link href="/dashboard/venues" className="hover:text-ink">
            Venues
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
          <span className="text-ink">{venue.name}</span>
        </div>
        <Link
          href="/dashboard/privacy-requests"
          className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-white px-2.5 py-1 text-xs font-semibold text-charcoal transition hover:border-ink hover:text-ink"
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Privacy requests
        </Link>
      </nav>

      <header className="mt-3 border-b border-hairline">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{venue.name}</h1>
        <div className="mt-4">
          <VenueTabs tabs={tabs} />
        </div>
      </header>

      <div className="mt-6">{children}</div>
    </div>
  );
}
