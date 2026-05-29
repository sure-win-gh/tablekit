import { asc, eq } from "drizzle-orm";

import { getActiveOrg } from "@/lib/auth/active-org";
import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { withUser } from "@/lib/db/client";
import { memberships, organisations, users, venues } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { signOut, switchActiveOrgAction } from "./actions";
import { SidebarShell, type SidebarData } from "./sidebar-shell";

// Server-side data loader for the sidebar. One round-trip to fetch
// the active org, the user's profile, and the venue list (RLS scopes
// the venue list to what the user can see — a venue-scoped host's
// sidebar lists only their permitted venues).
//
// Sign-out is bound here so the client component receives a stable
// server-action reference rather than re-importing.

export async function Sidebar() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const orgId = await getActiveOrg();
  if (!orgId) return null;

  const data = await withUser(async (db) => {
    const [me] = await db
      .select({ fullName: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const [org] = await db
      .select({
        id: organisations.id,
        name: organisations.name,
        plan: organisations.plan,
        groupCrmEnabled: organisations.groupCrmEnabled,
      })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    const venueRows = await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .orderBy(asc(venues.name));
    // Memberships for the org-switcher dropdown. RLS scopes this
    // to (memberships.organisation_id IN user_organisation_ids()),
    // so we'd see other people's rows in our orgs too — filter to
    // just our own to keep the projection tight.
    const myMemberships = await db
      .select({
        orgId: memberships.organisationId,
        orgName: organisations.name,
      })
      .from(memberships)
      .innerJoin(organisations, eq(organisations.id, memberships.organisationId))
      .where(eq(memberships.userId, user.id))
      .orderBy(asc(organisations.name));
    return { me, org, venues: venueRows, memberships: myMemberships };
  });

  if (!data.me || !data.org) return null;

  const payload: SidebarData = {
    user: {
      name: data.me.fullName ?? data.me.email,
      email: data.me.email,
    },
    org: {
      id: data.org.id,
      name: data.org.name,
      // CRM (per-venue + cross-venue) is Plus-only. The shell uses
      // this single boolean rather than re-deriving from plan strings.
      crmEnabled: hasPlan(toPlan(data.org.plan), "plus"),
      // AI enquiry inbox is Plus-only. Currently the same boolean as
      // crmEnabled, but kept distinct so a future tier split (e.g.
      // AI as a Premium add-on) doesn't require touching every CRM
      // consumer.
      aiEnquiryEnabled: hasPlan(toPlan(data.org.plan), "plus"),
      // Booking Insights surface is Plus-only — extends MVP reports
      // with lead-time, no-show trend, channel performance, and period
      // comparison. Kept distinct from crmEnabled so a future split is
      // a one-line change.
      insightsEnabled: hasPlan(toPlan(data.org.plan), "plus"),
      // Service Summary (capacity panel + heatmap + suggestions) is
      // Plus-only — the operator-maturity capacity-planning surface.
      serviceSummaryEnabled: hasPlan(toPlan(data.org.plan), "plus"),
      groupCrmEnabled: data.org.groupCrmEnabled,
      multiVenue: data.venues.length >= 2,
    },
    venues: data.venues,
    memberships: data.memberships,
  };

  return <SidebarShell data={payload} signOut={signOut} switchActiveOrg={switchActiveOrgAction} />;
}
