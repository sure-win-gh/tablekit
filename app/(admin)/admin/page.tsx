import { TrendChart } from "@/components/admin/charts";
import {
  type AlertItem,
  AlertStrip,
  Empty,
  HBar,
  KpiTile,
  Section,
  TABLE,
  TBODY,
  THEAD,
  gbp,
  pctStr,
} from "@/components/admin/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import {
  getActiveVenues,
  getBookingCounts,
  getBookingsByDay,
} from "@/lib/server/admin/dashboard/metrics/bookings";
import {
  getMessageVolume7d,
  getPlatformUsageThisMonth,
} from "@/lib/server/admin/dashboard/metrics/messages";
import { getOperationsSnapshot } from "@/lib/server/admin/dashboard/metrics/operations";
import { getSignupCounts, getSignupsByDay } from "@/lib/server/admin/dashboard/metrics/signups";
import { getMrrSnapshot } from "@/lib/server/admin/dashboard/stripe-billing";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const session = await requirePlatformAdmin();
  await platformAudit.log({ actorEmail: session.email, action: "login" });

  const db = adminDb();
  const [signups, signupsByDay, bookings, bookingsByDay, activeVenues, messages, usage, mrr, ops] =
    await Promise.all([
      getSignupCounts(db),
      getSignupsByDay(db, 30),
      getBookingCounts(db),
      getBookingsByDay(db, 30),
      getActiveVenues(db),
      getMessageVolume7d(db),
      getPlatformUsageThisMonth(db),
      getMrrSnapshot(),
      getOperationsSnapshot(db),
    ]);

  const usageTotalPence = usage.reduce((s, r) => s + r.costPence, 0);
  const usageTotalSends = usage.reduce((s, r) => s + r.count, 0);
  const sourceMax = bookings.sourceMix7d[0]?.count ?? 0;
  const sourceTotal = bookings.sourceMix7d.reduce((s, r) => s + r.count, 0);

  // Ops warnings surface here so a problem is visible without opening
  // /admin/operations. Healthy platform = no strip at all.
  const alerts: AlertItem[] = [];
  if (mrr.degraded) alerts.push({ label: "Stripe MRR degraded", href: "/admin/financials" });
  if (ops.webhooks.unhandledTotal > 0)
    alerts.push({
      label: `${ops.webhooks.unhandledTotal} unhandled Stripe webhooks`,
      href: "/admin/operations",
    });
  if (ops.dsars.overdue > 0)
    alerts.push({ label: `${ops.dsars.overdue} overdue DSARs`, href: "/admin/operations" });
  for (const m of ops.messages) {
    if (m.total >= 20 && m.bounced / m.total > 0.05) {
      alerts.push({
        label: `${m.channel} bounce ${pctStr(m.bounced / m.total)}`,
        href: "/admin/operations",
      });
    }
  }
  if (ops.paymentFailures7d.length > 0)
    alerts.push({
      label: `Payment failures in ${ops.paymentFailures7d.length} orgs`,
      href: "/admin/operations",
    });

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Overview</h1>
        <p className="text-ash text-sm">
          The platform at a glance — revenue, growth, usage, and anything on fire. UTC day buckets.
        </p>
      </header>

      <AlertStrip items={alerts} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiTile
          label="MRR"
          value={gbp(mrr.mrrMinor)}
          sub={
            mrr.degraded ? "Stripe degraded" : `as of ${mrr.asOf.toISOString().slice(11, 16)} UTC`
          }
          alert={mrr.degraded}
        />
        <KpiTile label="Active subs" value={String(mrr.activeSubs)} />
        <KpiTile
          label="Signups 30d"
          value={String(signups.last30d)}
          sub={`${signups.today} today · ${signups.last7d} last 7d`}
        />
        <KpiTile
          label="Bookings 30d"
          value={String(bookings.last30d)}
          sub={`${bookings.today} today · ${bookings.last7d} last 7d`}
        />
        <KpiTile
          label="Active venues 7d"
          value={String(activeVenues.activeLast7d)}
          sub={`of ${activeVenues.totalVenues} venues`}
        />
        <KpiTile
          label="Msg cost this month"
          value={gbp(usageTotalPence)}
          sub={`${usageTotalSends} metered sends`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section title="Signups — last 30 days" csvHref="/admin/export/signups">
          {signups.last30d === 0 ? (
            <Empty message="No signups in the last 30 days." />
          ) : (
            <TrendChart data={signupsByDay} label="Signups" color="var(--color-coral)" />
          )}
        </Section>

        <Section title="Bookings — last 30 days" csvHref="/admin/export/bookings">
          {bookings.last30d === 0 ? (
            <Empty message="No bookings in the last 30 days." />
          ) : (
            <TrendChart data={bookingsByDay} label="Bookings" />
          )}
        </Section>

        <Section
          title="Booking sources — last 7 days"
          description="Where platform bookings come from. Widget share is the one to grow."
        >
          {bookings.sourceMix7d.length === 0 ? (
            <Empty message="No bookings in the last 7 days." />
          ) : (
            <div className="flex flex-col gap-2">
              {bookings.sourceMix7d.map((row) => (
                <HBar
                  key={row.source}
                  label={row.source}
                  value={row.count}
                  max={sourceMax}
                  display={sourceTotal === 0 ? "—" : pctStr(row.count / sourceTotal)}
                  sub={`${row.count} bookings`}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Messaging — last 7 days"
          description="Delivery snapshot; full health breakdown lives in Operations."
          csvHref="/admin/export/messages"
        >
          {messages.length === 0 ? (
            <Empty message="No messages dispatched in the last 7 days." />
          ) : (
            <table className={TABLE}>
              <thead className={THEAD}>
                <tr>
                  <th className="py-1 font-medium">Channel</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody className={TBODY}>
                {messages.map((row) => (
                  <tr key={`${row.channel}-${row.status}`}>
                    <td className="text-ink py-1.5">{row.channel}</td>
                    <td
                      className={
                        row.status === "bounced" || row.status === "failed"
                          ? "text-rose py-1.5"
                          : "text-ink py-1.5"
                      }
                    >
                      {row.status}
                    </td>
                    <td className="text-ink py-1.5 text-right tabular-nums">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usage.length > 0 ? (
            <p className="text-ash mt-3 text-[11px]">
              Metered this month:{" "}
              {usage
                .map((u) => `${u.channel} ${u.count} (£${(u.costPence / 100).toFixed(2)})`)
                .join(" · ")}{" "}
              — pass-through at cost.
            </p>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
