import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { getOrgDetail } from "@/lib/server/admin/dashboard/metrics/org-detail";

export const dynamic = "force-dynamic";

export default async function AdminOrgDrillDownPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const session = await requirePlatformAdmin();
  const { orgId } = await params;

  const detail = await getOrgDetail(adminDb(), orgId);
  if (!detail) notFound();

  await platformAudit.log({
    actorEmail: session.email,
    action: "viewed_org",
    targetType: "organisation",
    targetId: orgId,
  });

  const { org, venues, members, counts30d, stripeConnect } = detail;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">{org.name}</h1>
        <p className="text-ash text-sm">
          {org.slug} · plan: {org.plan} · created {fmtDate(org.createdAt)}
        </p>
      </header>

      <Section title="Activity — last 30 days">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Bookings" value={counts30d.bookings.toString()} />
          <Stat label="Messages" value={counts30d.messages.toString()} />
          <Stat label="Payments succeeded" value={counts30d.paymentsSucceeded.toString()} />
        </div>
      </Section>

      <Section title={`Venues (${venues.length})`}>
        {venues.length === 0 ? (
          <Empty message="No venues." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-ash text-left">
              <tr>
                <th className="py-1 font-medium">Name</th>
                <th className="py-1 font-medium">Type</th>
                <th className="py-1 font-medium">Timezone</th>
                <th className="py-1 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y">
              {venues.map((v) => (
                <tr key={v.id}>
                  <td className="text-ink py-1.5">{v.name}</td>
                  <td className="text-ink py-1.5">{v.venueType}</td>
                  <td className="text-ash py-1.5">{v.timezone}</td>
                  <td className="text-ash py-1.5 tabular-nums">{fmtDate(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`Members (${members.length})`}>
        {members.length === 0 ? (
          <Empty message="No members." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-ash text-left">
              <tr>
                <th className="py-1 font-medium">Email</th>
                <th className="py-1 font-medium">Role</th>
                <th className="py-1 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y">
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="text-ink py-1.5">{m.email}</td>
                  <td className="text-ink py-1.5">{m.role}</td>
                  <td className="text-ash py-1.5 tabular-nums">{fmtDate(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Stripe Connect">
        {stripeConnect === null ? (
          <Empty message="Not connected." />
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <Field k="Account" v={stripeConnect.accountId} />
            <Field k="Details submitted" v={stripeConnect.detailsSubmitted ? "Yes" : "No"} />
            <Field k="Charges enabled" v={stripeConnect.chargesEnabled ? "Yes" : "No"} />
            <Field k="Payouts enabled" v={stripeConnect.payoutsEnabled ? "Yes" : "No"} />
          </dl>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card padding="lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border-hairline border bg-white px-3 py-2">
      <div className="text-ash text-xs">{label}</div>
      <div className="text-ink text-2xl font-bold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <p className="text-ash text-xs">{message}</p>;
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-ash">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </>
  );
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}
