import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";

// PR1 placeholder. Real KPI tiles + headline trends ship in PR2.
// requirePlatformAdmin() is also called by the (admin) layout — repeating
// it here is intentional defense-in-depth so any future page that omits
// the layout guard still rejects.
//
// Logging the login on render means a refresh re-logs; PR2's overview
// page replaces this and moves the login event into a once-per-session
// signal (audit_log dedup by actor + 1-min window).

export default async function AdminOverviewPage() {
  const session = await requirePlatformAdmin();

  await platformAudit.log({
    actorEmail: session.email,
    action: "login",
  });

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card padding="lg">
        <CardHeader>
          <CardTitle>Admin dashboard</CardTitle>
          <CardDescription>Tablekit-staff view. Cross-organisation by design.</CardDescription>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-charcoal">
            Auth gate live. KPI tiles, venue search, financials and ops health land in
            subsequent PRs (PR2–PR4 of the admin-dashboard rollout).
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
