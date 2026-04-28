import { Download } from "lucide-react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import {
  getOperationsSnapshot,
  type MessageHealth7dRow,
} from "@/lib/server/admin/dashboard/metrics/operations";

export const dynamic = "force-dynamic";

export default async function AdminOperationsPage() {
  await requirePlatformAdmin();
  const snap = await getOperationsSnapshot(adminDb());

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Operations</h1>
        <p className="text-sm text-ash">
          Platform-wide health: message delivery, payment failures, Stripe webhooks, open DSARs.
        </p>
      </header>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Message delivery — last 7 days</CardTitle>
        </CardHeader>
        <CardBody>
          {snap.messages.length === 0 ? (
            <Empty message="No messages in the last 7 days." />
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-ash">
                <tr>
                  <th className="py-1 font-medium">Channel</th>
                  <th className="py-1 text-right font-medium">Total</th>
                  <th className="py-1 text-right font-medium">Delivered</th>
                  <th className="py-1 text-right font-medium">Bounced</th>
                  <th className="py-1 text-right font-medium">Failed</th>
                  <th className="py-1 text-right font-medium">Bounce %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {snap.messages.map((row) => (
                  <tr key={row.channel}>
                    <td className="py-1.5 text-ink">{row.channel}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.total}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.delivered}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.bounced}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.failed}</td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        bounceAlertClass(row)
                      }`}
                    >
                      {bouncePct(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Payment failures — last 7 days</CardTitle>
          <a
            href="/admin/export/payment-failures"
            className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-white px-3 py-1 text-xs font-semibold text-ink transition hover:border-ink"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        </CardHeader>
        <CardBody>
          {snap.paymentFailures7d.length === 0 ? (
            <Empty message="No failed payments in the last 7 days." />
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-ash">
                <tr>
                  <th className="py-1 font-medium">Organisation</th>
                  <th className="py-1 text-right font-medium">Failures</th>
                  <th className="py-1 font-medium">Last failure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {snap.paymentFailures7d.map((row) => (
                  <tr key={row.orgId}>
                    <td className="py-1.5 text-ink">{row.orgName}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.count}</td>
                    <td className="py-1.5 tabular-nums text-ash">
                      {fmtDateTime(row.lastFailureAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Stripe webhooks</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Received last 24h" value={snap.webhooks.totalLast24h.toString()} />
            <Stat
              label="Unhandled (all-time)"
              value={snap.webhooks.unhandledTotal.toString()}
              alert={snap.webhooks.unhandledTotal > 0}
            />
            <Stat label="Last received" value={fmtDateTime(snap.webhooks.lastReceivedAt)} />
          </div>
        </CardBody>
      </Card>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Data subject access requests</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Open" value={snap.dsars.open.toString()} />
            <Stat
              label="Overdue"
              value={snap.dsars.overdue.toString()}
              alert={snap.dsars.overdue > 0}
            />
            <Stat label="Due within 7 days" value={snap.dsars.dueWithin7d.toString()} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function bouncePct(row: MessageHealth7dRow): string {
  if (row.total === 0) return "—";
  return `${((row.bounced / row.total) * 100).toFixed(1)}%`;
}

function bounceAlertClass(row: MessageHealth7dRow): string {
  if (row.total < 20) return "text-ash";
  const rate = row.bounced / row.total;
  return rate > 0.05 ? "text-rose" : "text-ink";
}

function Stat({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="rounded-card border border-hairline bg-white px-3 py-2">
      <div className="text-xs text-ash">{label}</div>
      <div
        className={`text-2xl font-bold tabular-nums tracking-tight ${
          alert ? "text-rose" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <p className="text-xs text-ash">{message}</p>;
}

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
