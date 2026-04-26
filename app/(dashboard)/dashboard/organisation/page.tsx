import { eq } from "drizzle-orm";
import { Building2, ChevronRight } from "lucide-react";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { organisations, venues } from "@/lib/db/schema";

import { GroupCrmToggle } from "./forms";

export const metadata = { title: "Organisation · TableKit" };

// Owner-level org settings. Single setting today (group CRM opt-in)
// — billing, team, and DPA download will land here over time.
//
// Read access is open to all members; writes (server actions) require
// owner role per requireRole inside the action.

export default async function OrganisationPage() {
  const { role } = await requireRole("host");
  const isOwner = role === "owner";

  const { org, venueCount } = await withUser(async (db) => {
    const [o] = await db
      .select({
        id: organisations.id,
        name: organisations.name,
        slug: organisations.slug,
        plan: organisations.plan,
        groupCrmEnabled: organisations.groupCrmEnabled,
      })
      .from(organisations)
      .limit(1);
    if (!o) return { org: null, venueCount: 0 };
    const v = await db.select({ id: venues.id }).from(venues).where(eq(venues.organisationId, o.id));
    return { org: o, venueCount: v.length };
  });

  if (!org) {
    throw new Error("OrganisationPage: no org under active session");
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="text-ink">Organisation</span>
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-ink">
          <Building2 className="h-6 w-6 text-coral" aria-hidden />
          {org.name}
        </h1>
        <p className="mt-1 text-sm text-ash">
          {org.plan} plan · slug <span className="font-mono">{org.slug}</span> · {venueCount}{" "}
          {venueCount === 1 ? "venue" : "venues"}
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Group CRM</h2>
        <p className="text-sm text-ash">
          When enabled, operators with access to multiple venues see a single guest list across all
          of them. Marketing consent stays per-venue — opting in at one venue doesn&apos;t opt the
          guest in at another.
        </p>
        {venueCount < 2 ? (
          <p className="rounded-card border border-hairline bg-cloud p-3 text-xs text-ash">
            This setting only takes effect once you have two or more venues.
          </p>
        ) : null}
        <GroupCrmToggle
          initialEnabled={org.groupCrmEnabled}
          disabled={!isOwner}
          ownerOnlyHint={!isOwner}
        />
      </section>
    </main>
  );
}
