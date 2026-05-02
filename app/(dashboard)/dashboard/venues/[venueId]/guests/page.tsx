import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { requirePlan } from "@/lib/auth/require-plan";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { withUser } from "@/lib/db/client";
import { loadOrgGuests } from "@/lib/guests/list";

export const metadata = { title: "Guests · TableKit" };
export const dynamic = "force-dynamic";

// Per-venue CRM. Plus-tier feature; available regardless of venue
// count (a single-venue Plus org sees its own guests here). Filters
// the org-scoped guests table to "guests with at least one booking
// at this venue" via lib/guests/list.ts.
//
// Cross-venue org-wide aggregation lives at /dashboard/guests and is
// additionally gated by organisations.group_crm_enabled.

export default async function VenueGuestsPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { venueId } = await params;
  if (!(await assertVenueVisible(venueId))) notFound();

  const rows = await withUser((db) => loadOrgGuests(db, { orgId, venueId }));

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-lg font-medium tracking-tight">Guests</h2>
        <p className="text-ash text-sm">
          Everyone who&apos;s booked at this venue. Click a guest to see their full profile and
          history across the organisation.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
          No guests yet. They&apos;ll appear here as soon as this venue takes its first bookings.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((g) => (
            <li key={g.id}>
              <Link
                href={`/dashboard/guests/${g.id}`}
                className="rounded-card border-hairline hover:border-ink block border bg-white px-4 py-3 transition"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col">
                    <span className="text-ink text-sm font-semibold">{g.firstName}</span>
                    <span className="text-ash text-xs">
                      {g.visits} {g.visits === 1 ? "visit" : "visits"}
                      {g.lastVisit ? ` · last seen ${g.lastVisit.toLocaleDateString("en-GB")}` : ""}
                    </span>
                  </div>
                  <ChevronRight className="text-stone h-4 w-4" aria-hidden />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
