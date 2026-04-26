import { desc, eq } from "drizzle-orm";
import { Plus, ShieldCheck, Store } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui";
import { getActiveOrg } from "@/lib/auth/active-org";
import { withUser } from "@/lib/db/client";
import { organisations, users, venues } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { signOut } from "../actions";

// Middleware already guarantees an authed session for /dashboard/*.
// We re-check here defensively — middleware runs first, but belts and
// braces in case it's ever short-circuited or misconfigured.
//
// Routing matrix:
//   0 venues  → render the empty-state on this page (create-first-venue)
//   1 venue   → redirect to that venue's bookings page
//   2+ venues → redirect to the group /dashboard/overview

export default async function DashboardPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeOrgId = await getActiveOrg();
  if (!activeOrgId) redirect("/login?error=no_active_org");

  const data = await withUser(async (db) => {
    const [me] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const [org] = await db
      .select()
      .from(organisations)
      .where(eq(organisations.id, activeOrgId))
      .limit(1);
    const venueRows = await db
      .select({
        id: venues.id,
        name: venues.name,
        venueType: venues.venueType,
      })
      .from(venues)
      .orderBy(desc(venues.createdAt));
    return { me, org, venues: venueRows };
  });

  if (!data.me || !data.org) {
    throw new Error("Dashboard: could not load user or organisation");
  }

  if (data.venues.length === 1) {
    redirect(`/dashboard/venues/${data.venues[0]!.id}/bookings`);
  }
  if (data.venues.length >= 2) {
    redirect("/dashboard/overview");
  }

  // Zero-venue state.
  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{data.org.name}</h1>
          <p className="mt-0.5 text-sm text-ash">
            {data.org.plan} plan · slug <span className="font-mono">{data.org.slug}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link
            href="/dashboard/privacy-requests"
            className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-white px-2.5 py-1 text-xs font-semibold text-charcoal transition hover:border-ink hover:text-ink"
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Privacy requests
          </Link>
          <span className="text-charcoal">{data.me.fullName ?? data.me.email}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="text-ash underline underline-offset-4 hover:text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="mt-10 flex flex-col items-center gap-4 rounded-card border border-dashed border-hairline p-12 text-center">
        <Store className="h-8 w-8 text-stone" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-bold tracking-tight text-ink">
            Welcome. Let&apos;s set up your first venue.
          </h2>
          <p className="max-w-md text-sm text-ash">
            Pick a type (café, restaurant, or bar / pub) and we&apos;ll seed a floor plan and a
            service schedule so you can start taking bookings today. Everything&apos;s editable
            afterwards.
          </p>
        </div>
        <Link href="/dashboard/venues/new">
          <Button>
            <Plus className="h-4 w-4" aria-hidden />
            Create venue
          </Button>
        </Link>
      </section>
    </main>
  );
}
