import { eq } from "drizzle-orm";
import { Building2, ChevronRight, Users } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui";
import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { organisations } from "@/lib/db/schema";
import { loadOrgGuests } from "@/lib/guests/list";

export const metadata = { title: "Guests · TableKit" };
export const dynamic = "force-dynamic";

// Cross-venue guest list — Plus-tier feature, gated additionally by
// organisations.group_crm_enabled (org-wide opt-in to cross-venue
// staff visibility). Single-venue Plus orgs use the per-venue CRM at
// /dashboard/venues/[venueId]/guests instead — this page hides for
// them. We don't decrypt PII for the list view: first_name is
// plaintext (per schema), the aggregates (visits, venues, last visit)
// are non-PII. Decryption happens only on the per-guest detail screen.

export default async function GuestsPage() {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { org, rows } = await withUser(async (db) => {
    const [o] = await db
      .select({
        id: organisations.id,
        groupCrmEnabled: organisations.groupCrmEnabled,
      })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    if (!o) return { org: null, rows: [] };
    const guestRows = o.groupCrmEnabled ? await loadOrgGuests(db, { orgId: o.id }) : [];
    return { org: o, rows: guestRows };
  });

  if (!org) {
    throw new Error("GuestsPage: no org under active session");
  }

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Guests</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Users className="text-coral h-6 w-6" aria-hidden />
          Cross-venue guests
        </h1>
        <p className="text-ash mt-1 text-sm">
          Every guest who&apos;s booked at any venue in this organisation.
        </p>
      </header>

      {!org.groupCrmEnabled ? (
        <Card padding="lg" className="mt-8 flex flex-col items-center gap-3 text-center">
          <Building2 className="text-stone h-8 w-8" aria-hidden />
          <h2 className="text-ink text-lg font-bold tracking-tight">Group CRM is off</h2>
          <p className="text-ash max-w-md text-sm">
            Cross-venue guest visibility is disabled for this organisation. Owners can switch it on
            from the organisation page. Each venue&apos;s own guests are always available from that
            venue&apos;s sidebar.
          </p>
          <Link
            href="/dashboard/organisation"
            className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1.5 text-xs font-semibold transition"
          >
            Open organisation settings
          </Link>
        </Card>
      ) : rows.length === 0 ? (
        <p className="rounded-card border-hairline text-ash mt-8 border border-dashed p-12 text-center text-sm">
          No guests yet. They&apos;ll appear here as soon as your venues take their first bookings.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
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
                      {" · "}
                      {g.venuesVisited} {g.venuesVisited === 1 ? "venue" : "venues"}
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
    </main>
  );
}
