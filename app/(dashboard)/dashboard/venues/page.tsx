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
      <header className="border-hairline flex flex-wrap items-baseline justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-ink text-2xl font-bold tracking-tight">Venues</h1>
          <p className="text-ash mt-1 text-sm">
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
        <div className="rounded-card border-hairline mt-10 flex flex-col items-center gap-4 border border-dashed p-12 text-center">
          <Store className="text-stone h-8 w-8" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <h2 className="text-ink text-lg font-bold tracking-tight">Create your first venue</h2>
            <p className="text-ash max-w-md text-sm">
              Pick a type and we&apos;ll seed it with sensible defaults — areas, tables and a
              service schedule. You can change everything afterwards.
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
                className="group rounded-card border-hairline hover:border-ink flex items-center justify-between border bg-white px-4 py-3 transition"
              >
                <div className="flex flex-col">
                  <span className="text-ink text-sm font-semibold">{v.name}</span>
                  <span className="text-ash text-xs">
                    {v.venueType.replace("_", " ")} · {v.timezone}
                  </span>
                </div>
                <ArrowRight
                  className="text-mute group-hover:text-ink h-4 w-4 transition group-hover:translate-x-0.5"
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
