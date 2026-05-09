import { and, eq } from "drizzle-orm";

import { getActiveOrg } from "@/lib/auth/active-org";
import { decideMfaGate, getMfaState } from "@/lib/auth/mfa";
import { withUser } from "@/lib/db/client";
import { memberships } from "@/lib/db/schema";
import { supabaseServer } from "@/lib/db/supabase-server";

import { MfaWall } from "./mfa-wall";
import { Sidebar } from "./sidebar";

// Dashboard layout. In addition to the sidebar+main shell, this is
// where the TOTP MFA gate fires: any owner/manager whose session is
// not at AAL2 sees the MfaWall instead of the requested page until
// they enrol (or, if a factor exists, complete the challenge).
//
// The gate intentionally lives at layout level — not inside
// requireRole — so a single decision applies to every page in the
// dashboard, including ones that don't run requireRole on render
// (e.g. anything that just reads from RLS-scoped queries).
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session — fall through to inner pages. Most call requireRole()
  // which redirects to /login; the layout's job is only to decide
  // whether to render the wall.
  if (user) {
    const orgId = await getActiveOrg();
    if (orgId) {
      const member = await withUser(async (db) => {
        const [row] = await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(eq(memberships.userId, user.id), eq(memberships.organisationId, orgId)),
          )
          .limit(1);
        return row;
      });

      if (member) {
        const mfa = await getMfaState();
        if (mfa) {
          const decision = decideMfaGate(member.role, mfa);
          if (decision.kind === "enrol") {
            return <MfaWall mode="enrol" />;
          }
          if (decision.kind === "challenge") {
            return <MfaWall mode="challenge" factorId={decision.factorId} />;
          }
        }
      }
    }
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
