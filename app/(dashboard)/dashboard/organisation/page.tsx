import { eq } from "drizzle-orm";
import { Building2, ChevronRight, KeyRound, UserPlus, Webhook } from "lucide-react";
import Link from "next/link";

import { hasPlan, toPlan } from "@/lib/auth/plan-level";
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
    const v = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.organisationId, o.id));
    return { org: o, venueCount: v.length };
  });

  if (!org) {
    throw new Error("OrganisationPage: no org under active session");
  }

  const isPlus = hasPlan(toPlan(org.plan), "plus");

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Organisation</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Building2 className="text-coral h-6 w-6" aria-hidden />
          {org.name}
        </h1>
        <p className="text-ash mt-1 text-sm">
          {org.plan} plan · slug <span className="font-mono">{org.slug}</span> · {venueCount}{" "}
          {venueCount === 1 ? "venue" : "venues"}
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-2">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Group CRM</h2>
        <p className="text-ash text-sm">
          When enabled, operators with access to multiple venues see a single guest list across all
          of them at <span className="font-mono">/dashboard/guests</span>. Marketing consent stays
          per-venue — opting in at one venue doesn&apos;t opt the guest in at another. Each
          venue&apos;s own guest list is always available from that venue&apos;s sidebar regardless
          of this setting.
        </p>
        {!isPlus ? (
          <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
            Group CRM is a Plus-tier feature. The CRM (per-venue and cross-venue) requires the Plus
            plan; upgrade from the Billing page to enable it.
          </p>
        ) : venueCount < 2 ? (
          <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
            With one venue this aggregate view is the same as the per-venue CRM, so there&apos;s
            nothing to enable yet. Add another venue and the toggle becomes meaningful.
          </p>
        ) : null}
        <GroupCrmToggle
          initialEnabled={org.groupCrmEnabled}
          disabled={!isOwner || !isPlus || venueCount < 2}
          ownerOnlyHint={!isOwner}
        />
      </section>

      <section className="mt-8 flex flex-col gap-2">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Team</h2>
        <p className="text-ash text-sm">
          Members of this organisation and pending invitations. Owners can invite teammates by
          email.
        </p>
        <Link
          href="/dashboard/organisation/team"
          className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
        >
          <UserPlus className="text-ash h-4 w-4" aria-hidden />
          Manage team
          <ChevronRight className="text-stone h-4 w-4" aria-hidden />
        </Link>
      </section>

      {isPlus && isOwner ? (
        <section className="mt-8 flex flex-col gap-2">
          <h2 className="text-ink text-sm font-semibold tracking-tight">API access</h2>
          <p className="text-ash text-sm">
            Issue Bearer tokens for the public REST API at{" "}
            <span className="font-mono">api.tablekit.uk/v1</span>. Owner-only.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/organisation/api-keys"
              className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
            >
              <KeyRound className="text-ash h-4 w-4" aria-hidden />
              Manage API keys
              <ChevronRight className="text-stone h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/dashboard/organisation/webhooks"
              className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
            >
              <Webhook className="text-ash h-4 w-4" aria-hidden />
              Manage webhooks
              <ChevronRight className="text-stone h-4 w-4" aria-hidden />
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
