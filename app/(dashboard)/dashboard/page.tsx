import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { getActiveOrg } from "@/lib/auth/active-org";
import { withUser } from "@/lib/db/client";
import { organisations, users } from "@/lib/db/schema";
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
    return { me, org };
  });

  // Defensive: both rows should exist by the time we hit the
  // dashboard; if not, something's wrong with the signup flow and
  // we'd rather surface a clear error than render a half-page.
  if (!data.me || !data.org) {
    throw new Error("Dashboard: could not load user or organisation");
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
      <section className="mt-8">
        <p className="text-sm text-neutral-600">
          This is the operator dashboard shell. Venues, services, bookings and the rest of the
          operator tooling land with their own specs.
        </p>
      </section>
    </main>
  );
}
