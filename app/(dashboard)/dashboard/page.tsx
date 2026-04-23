import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getActiveOrg } from "@/lib/auth/active-org";
import { withUser } from "@/lib/db/client";
import { organisations, users, venues } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { signOut } from "../actions";

// Middleware already guarantees an authed session for /dashboard/*.
// We re-check here defensively — middleware runs first, but belts and
// braces in case it's ever short-circuited or misconfigured.

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

  // Single-venue orgs get routed straight to their venue — the
  // dashboard landing is for the zero / multi case. When multi-venue
  // UX matures (Plus tier), this is where the picker lives.
  if (data.venues.length === 1) {
    redirect(`/dashboard/venues/${data.venues[0]!.id}/floor-plan`);
  }

  return (
    <main className="flex flex-1 flex-col p-6">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.org.name}</h1>
          <p className="text-sm text-neutral-500">
            {data.org.plan} plan · slug <span className="font-mono">{data.org.slug}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-700">{data.me.fullName ?? data.me.email}</span>
          <form action={signOut}>
            <button type="submit" className="text-neutral-500 underline hover:text-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {data.venues.length === 0 ? (
        <section className="mt-10 flex flex-col items-center gap-3 rounded-md border border-dashed border-neutral-300 p-12 text-center">
          <h2 className="text-lg font-medium">Welcome. Let&apos;s set up your first venue.</h2>
          <p className="max-w-md text-sm text-neutral-500">
            Pick a type (café, restaurant, or bar / pub) and we&apos;ll seed a floor plan and a
            service schedule so you can start taking bookings today. Everything&apos;s editable
            afterwards.
          </p>
          <Link
            href="/dashboard/venues/new"
            className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            Create venue
          </Link>
        </section>
      ) : (
        <section className="mt-8">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium">Your venues</h2>
            <Link
              href="/dashboard/venues/new"
              className="text-sm text-neutral-500 underline hover:text-neutral-900"
            >
              + New venue
            </Link>
          </div>
          <ul className="mt-3 divide-y divide-neutral-200">
            {data.venues.map((v) => (
              <li key={v.id} className="py-3">
                <Link
                  href={`/dashboard/venues/${v.id}/floor-plan`}
                  className="flex items-baseline justify-between hover:underline"
                >
                  <span className="font-medium text-neutral-900">{v.name}</span>
                  <span className="font-mono text-xs text-neutral-500">{v.venueType}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
