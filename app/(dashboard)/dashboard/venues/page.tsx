import { desc } from "drizzle-orm";
import { ArrowRight, Plus, Store } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui";
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
    <main className="flex flex-1 flex-col px-8 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Venues</h1>
          <p className="mt-1 text-sm text-ash">
            {rows.length === 0
              ? "No venues yet — create one to start taking bookings."
              : `${rows.length} venue${rows.length === 1 ? "" : "s"} in this organisation.`}
          </p>
        </div>
        <Link href="/dashboard/venues/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            New venue
          </Button>
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-4 rounded-card border border-dashed border-hairline p-12 text-center">
          <Store className="h-8 w-8 text-stone" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-bold tracking-tight text-ink">
              Create your first venue
            </h2>
            <p className="max-w-md text-sm text-ash">
              Pick a type and we&apos;ll seed it with sensible defaults — areas, tables and a service
              schedule. You can change everything afterwards.
            </p>
          </div>
          <Link href="/dashboard/venues/new" className="mt-2">
            <Button>
              <Plus className="h-4 w-4" aria-hidden />
              Get started
            </Button>
          </Link>
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {rows.map((v) => (
            <li key={v.id}>
              <Link
                href={`/dashboard/venues/${v.id}/floor-plan`}
                className="group flex items-center justify-between rounded-card border border-hairline bg-white px-4 py-3 transition hover:border-ink"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-ink">{v.name}</span>
                  <span className="text-xs text-ash">
                    {v.venueType.replace("_", " ")} · {v.timezone}
                  </span>
                </div>
                <ArrowRight
                  className="h-4 w-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-ink"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
