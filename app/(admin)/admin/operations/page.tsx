import Link from "next/link";

import { TrendChart } from "@/components/admin/charts";
import {
  Chip,
  Empty,
  HBar,
  KpiTile,
  Section,
  TABLE,
  TBODY,
  THEAD,
  fmtDateTimeUtc,
  pctStr,
  timeAgo,
} from "@/components/admin/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import {
  getApiHealth,
  getOperatorWebhookHealth,
} from "@/lib/server/admin/dashboard/metrics/api-health";
import {
  getOperationsSnapshot,
  type MessageHealth7dRow,
} from "@/lib/server/admin/dashboard/metrics/operations";

export const dynamic = "force-dynamic";

export default async function AdminOperationsPage() {
  await requirePlatformAdmin();
  const db = adminDb();
  const [snap, api, hooks] = await Promise.all([
    getOperationsSnapshot(db),
    getApiHealth(db),
    getOperatorWebhookHealth(db),
  ]);

  const failureMax = snap.paymentFailures7d[0]?.count ?? 0;
  const now = new Date();

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Operations</h1>
        <p className="text-ash text-sm">
          Platform health: message delivery, payment failures, Stripe webhooks, DSARs, public API,
          and operator webhooks.
        </p>
      </header>

      <Section
        title="Message delivery — last 7 days"
        description="Bounce rate over 5% (at ≥20 messages) is flagged."
      >
        {snap.messages.length === 0 ? (
          <Empty message="No messages in the last 7 days." />
        ) : (
          <table className={TABLE}>
            <thead className={THEAD}>
              <tr>
                <th className="py-1 font-medium">Channel</th>
                <th className="py-1 text-right font-medium">Total</th>
                <th className="py-1 text-right font-medium">Delivered</th>
                <th className="py-1 text-right font-medium">Bounced</th>
                <th className="py-1 text-right font-medium">Failed</th>
                <th className="py-1 text-right font-medium">Bounce rate</th>
              </tr>
            </thead>
            <tbody className={TBODY}>
              {snap.messages.map((row) => (
                <tr key={row.channel}>
                  <td className="text-ink py-1.5">{row.channel}</td>
                  <td className="text-ink py-1.5 text-right tabular-nums">{row.total}</td>
                  <td className="text-ink py-1.5 text-right tabular-nums">{row.delivered}</td>
                  <td className="text-ink py-1.5 text-right tabular-nums">{row.bounced}</td>
                  <td className="text-ink py-1.5 text-right tabular-nums">{row.failed}</td>
                  <td className="py-1.5 text-right">
                    <BounceChip row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section
          title="Public API"
          description="7-day requests, error rates, and latency from the v1 API request log; the chart shows the 14-day trend."
        >
          {api.requests7d === 0 ? (
            <Empty message="No API traffic in the last 7 days." />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiTile label="Requests" value={api.requests7d.toLocaleString("en-GB")} />
                <KpiTile
                  label="5xx rate"
                  value={pctStr(api.errorRate7d, 2)}
                  sub={`${api.serverErrors7d} errors · ${api.clientErrors7d} 4xx`}
                  alert={api.errorRate7d > 0.01}
                />
                <KpiTile
                  label="p50 latency"
                  value={api.p50LatencyMs === null ? "—" : `${api.p50LatencyMs}ms`}
                />
                <KpiTile
                  label="p95 latency"
                  value={api.p95LatencyMs === null ? "—" : `${api.p95LatencyMs}ms`}
                  alert={api.p95LatencyMs !== null && api.p95LatencyMs > 1000}
                />
              </div>
              <div className="mt-4">
                <TrendChart data={api.byDay} label="Requests" height={120} />
              </div>
              {api.topOrgs.length > 0 ? (
                <div className="mt-4 flex flex-col gap-2">
                  {api.topOrgs.map((o) => (
                    <HBar
                      key={o.orgId}
                      label={
                        <Link href={`/admin/venues/${o.orgId}`} className="hover:underline">
                          {o.orgName}
                        </Link>
                      }
                      value={o.requests}
                      max={api.topOrgs[0]?.requests ?? 0}
                      display={o.requests.toLocaleString("en-GB")}
                      sub={o.serverErrors > 0 ? `${o.serverErrors} 5xx` : "no 5xx"}
                      color={o.serverErrors > 0 ? "var(--color-rose)" : "var(--color-ink)"}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </Section>

        <Section
          title="Operator webhooks — last 7 days"
          description="Outbound deliveries to operator endpoints. A failing endpoint burns retries silently — chase these."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Active subs" value={String(hooks.activeSubscriptions)} />
            <KpiTile label="Deliveries" value={String(hooks.deliveries7d)} />
            <KpiTile
              label="Failed"
              value={String(hooks.failed7d)}
              alert={hooks.failed7d > 0}
              sub={
                hooks.deliveries7d === 0 ? undefined : pctStr(hooks.failed7d / hooks.deliveries7d)
              }
            />
            <KpiTile label="Pending now" value={String(hooks.pendingNow)} />
          </div>
          {hooks.failingEndpoints.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2">
              {hooks.failingEndpoints.map((e) => (
                <HBar
                  key={e.subscriptionId}
                  label={
                    <Link href={`/admin/venues/${e.orgId}`} className="hover:underline">
                      {e.orgName} · {e.label}
                    </Link>
                  }
                  value={e.failed7d}
                  max={hooks.failingEndpoints[0]?.failed7d ?? 0}
                  display={`${e.failed7d}×`}
                  sub={hostnameOf(e.url)}
                  color="var(--color-rose)"
                />
              ))}
            </div>
          ) : hooks.deliveries7d > 0 ? (
            <p className="text-ash mt-3 text-xs">No failing endpoints. All deliveries healthy.</p>
          ) : null}
        </Section>
      </div>

      <Section
        title="Payment failures — last 7 days"
        description="Failed / requires_payment_method by organisation. Often a stuck deposit rule."
        csvHref="/admin/export/payment-failures"
      >
        {snap.paymentFailures7d.length === 0 ? (
          <Empty message="No failed payments in the last 7 days." />
        ) : (
          <div className="flex flex-col gap-2">
            {snap.paymentFailures7d.map((row) => (
              <HBar
                key={row.orgId}
                label={
                  <Link href={`/admin/venues/${row.orgId}`} className="hover:underline">
                    {row.orgName}
                  </Link>
                }
                value={row.count}
                max={failureMax}
                display={`${row.count}×`}
                sub={timeAgo(row.lastFailureAt, now)}
                color="var(--color-rose)"
              />
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section title="Stripe webhooks">
          <div className="grid grid-cols-3 gap-3">
            <KpiTile label="Received 24h" value={String(snap.webhooks.totalLast24h)} />
            <KpiTile
              label="Unhandled"
              value={String(snap.webhooks.unhandledTotal)}
              alert={snap.webhooks.unhandledTotal > 0}
              sub="all-time"
            />
            <KpiTile
              label="Last received"
              value={timeAgo(snap.webhooks.lastReceivedAt, now)}
              sub={fmtDateTimeUtc(snap.webhooks.lastReceivedAt)}
            />
          </div>
        </Section>

        <Section title="Data subject access requests">
          <div className="grid grid-cols-3 gap-3">
            <KpiTile label="Open" value={String(snap.dsars.open)} />
            <KpiTile
              label="Overdue"
              value={String(snap.dsars.overdue)}
              alert={snap.dsars.overdue > 0}
            />
            <KpiTile label="Due within 7d" value={String(snap.dsars.dueWithin7d)} />
          </div>
        </Section>
      </div>
    </div>
  );
}

// Hostname only — operator URLs can embed tokens in paths/queries.
// Defensive fallback: a malformed stored URL must not 500 the page.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function BounceChip({ row }: { row: MessageHealth7dRow }) {
  if (row.total === 0) return <Chip tone="neutral">—</Chip>;
  const rate = row.bounced / row.total;
  const display = pctStr(rate);
  if (row.total < 20) return <Chip tone="neutral">{display}</Chip>;
  return <Chip tone={rate > 0.05 ? "rose" : "ink"}>{display}</Chip>;
}
