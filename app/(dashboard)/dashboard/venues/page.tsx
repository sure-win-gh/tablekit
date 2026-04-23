import { desc } from "drizzle-orm";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

export const metadata = {
  title: "Venues · TableKit",
};

export default async function VenuesPage() {
  // Any member can read the list; writes are gated at the action.
  await requireRole("host");

  const rows = await withUser(async (db) => {
    return db
      .select({
        id: venues.id,
        name: venues.name,
        venueType: venues.venueType,
        timezone: venues.timezone,
        createdAt: venues.createdAt,
      })
      .from(venues)
      .orderBy(desc(venues.createdAt));
  });

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Venues</h1>
          <p className="text-sm text-neutral-500">
            {rows.length === 0
              ? "No venues yet — create one to start taking bookings."
              : `${rows.length} venue${rows.length === 1 ? "" : "s"} in this organisation.`}
          </p>
        </div>
        <Link
          href="/dashboard/venues/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800"
        >
          New venue
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 rounded-md border border-dashed border-neutral-300 p-12 text-center">
          <h2 className="text-lg font-medium">Create your first venue</h2>
          <p className="max-w-md text-sm text-neutral-500">
            Pick a type and we&apos;ll seed it with sensible defaults — areas, tables and a service
            schedule. You can change everything afterwards.
          </p>
          <Link
            href="/dashboard/venues/new"
            className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            Get started
          </Link>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200">
          {rows.map((v) => (
            <li key={v.id} className="py-4">
              <Link
                href={`/dashboard/venues/${v.id}/floor-plan`}
                className="flex items-baseline justify-between hover:underline"
              >
                <span className="font-medium text-neutral-900">{v.name}</span>
                <span className="font-mono text-xs text-neutral-500">
                  {v.venueType} · {v.timezone}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
