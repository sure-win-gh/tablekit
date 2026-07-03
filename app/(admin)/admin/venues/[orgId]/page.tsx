import { notFound } from "next/navigation";

import { TrendChart } from "@/components/admin/charts";
import { Chip, Empty, KpiTile, Section, TABLE, TBODY, THEAD, timeAgo } from "@/components/admin/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { getOrgDetail } from "@/lib/server/admin/dashboard/metrics/org-detail";

import { ResetPasswordControl } from "./reset-control";

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

  const { org, venues, members, counts30d, bookingsByDay, stripeConnect } = detail;
  const now = new Date();

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-ink text-2xl font-bold tracking-tight">{org.name}</h1>
          <p className="text-ash text-sm">
            {org.slug} · created {fmtDate(org.createdAt)} ({timeAgo(org.createdAt, now)})
          </p>
        </div>
        <Chip tone={org.plan === "free" ? "neutral" : "coral"}>{org.plan}</Chip>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <KpiTile label="Bookings 30d" value={String(counts30d.bookings)} />
        <KpiTile label="Messages 30d" value={String(counts30d.messages)} />
        <KpiTile label="Payments succeeded 30d" value={String(counts30d.paymentsSucceeded)} />
      </div>

      <Section
        title="Bookings — last 30 days"
        description="Bookings created per UTC day, this organisation only."
      >
        {counts30d.bookings === 0 ? (
          <Empty message="No bookings in the last 30 days." />
        ) : (
          <TrendChart data={bookingsByDay} label="Bookings" height={140} />
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section title={`Venues (${venues.length})`}>
          {venues.length === 0 ? (
            <Empty message="No venues." />
          ) : (
            <table className={TABLE}>
              <thead className={THEAD}>
                <tr>
                  <th className="py-1 font-medium">Name</th>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Timezone</th>
                  <th className="py-1 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className={TBODY}>
                {venues.map((v) => (
                  <tr key={v.id}>
                    <td className="text-ink py-1.5">{v.name}</td>
                    <td className="py-1.5">
                      <Chip>{v.venueType.replace("_", " / ")}</Chip>
                    </td>
                    <td className="text-ash py-1.5">{v.timezone}</td>
                    <td className="text-ash py-1.5 tabular-nums" title={fmtDate(v.createdAt)}>
                      {timeAgo(v.createdAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Stripe Connect">
          {stripeConnect === null ? (
            <Empty message="Not connected — this org can't take deposits yet." />
          ) : (
            <div className="flex flex-col gap-2 text-xs">
              <div className="text-ash">
                Account <span className="text-ink font-mono">{stripeConnect.accountId}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip tone={stripeConnect.detailsSubmitted ? "ink" : "rose"}>
                  details {stripeConnect.detailsSubmitted ? "submitted" : "missing"}
                </Chip>
                <Chip tone={stripeConnect.chargesEnabled ? "ink" : "rose"}>
                  charges {stripeConnect.chargesEnabled ? "enabled" : "disabled"}
                </Chip>
                <Chip tone={stripeConnect.payoutsEnabled ? "ink" : "rose"}>
                  payouts {stripeConnect.payoutsEnabled ? "enabled" : "disabled"}
                </Chip>
              </div>
              {!stripeConnect.payoutsEnabled ? (
                <p className="text-ash">
                  Stalled onboarding — check the requirements list in the Stripe dashboard.
                </p>
              ) : null}
            </div>
          )}
        </Section>
      </div>

      <Section title={`Members (${members.length})`}>
        {members.length === 0 ? (
          <Empty message="No members." />
        ) : (
          <table className={TABLE}>
            <thead className={THEAD}>
              <tr>
                <th className="py-1 font-medium">Email</th>
                <th className="py-1 font-medium">Role</th>
                <th className="py-1 font-medium">Joined</th>
                <th className="py-1 font-medium">Password</th>
              </tr>
            </thead>
            <tbody className={TBODY}>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="text-ink py-1.5">{m.email}</td>
                  <td className="py-1.5">
                    <Chip tone={m.role === "owner" ? "coral" : "neutral"}>{m.role}</Chip>
                  </td>
                  <td className="text-ash py-1.5 tabular-nums" title={fmtDate(m.createdAt)}>
                    {timeAgo(m.createdAt, now)}
                  </td>
                  <td className="py-1.5 align-top">
                    <ResetPasswordControl userId={m.userId} email={m.email} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}
