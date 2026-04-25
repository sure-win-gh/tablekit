import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

// Shared chrome for every route under /dashboard/venues/[venueId]:
// venue name as h1, and a tab nav across to floor plan / services /
// settings. If the venue id doesn't resolve for the current user
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

  const tabs: Array<{ href: string; label: string }> = [
    { href: `/dashboard/venues/${venue.id}/floor-plan`, label: "Floor plan" },
    { href: `/dashboard/venues/${venue.id}/bookings`, label: "Bookings" },
    { href: `/dashboard/venues/${venue.id}/waitlist`, label: "Waitlist" },
    { href: `/dashboard/venues/${venue.id}/services`, label: "Services" },
    { href: `/dashboard/venues/${venue.id}/deposits`, label: "Deposits" },
    { href: `/dashboard/venues/${venue.id}/settings`, label: "Settings" },
  ];

  return (
    <div className="flex flex-1 flex-col p-6">
      <nav className="text-sm">
        <Link href="/dashboard/venues" className="text-neutral-500 hover:underline">
          Venues
        </Link>
        <span className="text-neutral-400"> / </span>
        <span className="text-neutral-900">{venue.name}</span>
      </nav>

      <header className="mt-4 border-b border-neutral-200 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{venue.name}</h1>
        <div className="mt-4 flex gap-1 text-sm">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="rounded-md px-3 py-1.5 text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900"
            >
              {t.label}
            </Link>
          ))}
        </div>
      </header>

      <div className="mt-6">{children}</div>
    </div>
  );
}
