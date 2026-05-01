import { Download } from "lucide-react";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { getConnectFunnel } from "@/lib/server/admin/dashboard/metrics/connect-funnel";
import { getMrrSnapshot, type MrrSnapshot } from "@/lib/server/admin/dashboard/stripe-billing";

export const dynamic = "force-dynamic";

export default async function AdminFinancialsPage() {
  await requirePlatformAdmin();

  const [mrr, funnel] = await Promise.all([getMrrSnapshot(), getConnectFunnel(adminDb())]);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Financials</h1>
        <p className="text-ash text-sm">
          Live Stripe pull, cached for 5 minutes. Per-org MRR contribution is deferred until the
          billing-customer column is confirmed.
        </p>
      </header>

      {mrr.degraded ? <DegradedBanner snapshot={mrr} /> : null}

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Monthly recurring revenue</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="MRR" value={gbp(mrr.mrrMinor)} />
            <Stat label="Active subscriptions" value={mrr.activeSubs.toString()} />
            <Stat label="As of" value={fmtTime(mrr.asOf)} />
          </div>
          <h3 className="text-ash mt-6 mb-2 text-xs font-semibold tracking-wide uppercase">
            By tier
          </h3>
          {Object.keys(mrr.byTier).length === 0 ? (
            <p className="text-ash text-xs">No active subscriptions.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-ash text-left">
                <tr>
                  <th className="py-1 font-medium">Tier (lookup_key)</th>
                  <th className="py-1 text-right font-medium">MRR</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {Object.entries(mrr.byTier)
                  .sort(([, a], [, b]) => b - a)
                  .map(([tier, minor]) => (
                    <tr key={tier}>
                      <td className="text-ink py-1.5">{tier}</td>
                      <td className="text-ink py-1.5 text-right tabular-nums">{gbp(minor)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Stripe Connect onboarding funnel</CardTitle>
          <a
            href="/admin/export/connect-funnel"
            className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1 text-xs font-semibold transition"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        </CardHeader>
        <CardBody>
          <table className="w-full text-xs">
            <thead className="text-ash text-left">
              <tr>
                <th className="py-1 font-medium">Stage</th>
                <th className="py-1 text-right font-medium">Orgs</th>
                <th className="py-1 text-right font-medium">% of total</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y">
              <FunnelRow label="All organisations" n={funnel.totalOrgs} total={funnel.totalOrgs} />
              <FunnelRow
                label="Connect account created"
                n={funnel.hasAccount}
                total={funnel.totalOrgs}
              />
              <FunnelRow
                label="Details submitted"
                n={funnel.detailsSubmitted}
                total={funnel.totalOrgs}
              />
              <FunnelRow
                label="Charges enabled"
                n={funnel.chargesEnabled}
                total={funnel.totalOrgs}
              />
              <FunnelRow
                label="Payouts enabled"
                n={funnel.payoutsEnabled}
                total={funnel.totalOrgs}
              />
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

function DegradedBanner({ snapshot }: { snapshot: MrrSnapshot }) {
  const message =
    snapshot.reason === "stripe_not_configured"
      ? "Stripe is not configured (STRIPE_SECRET_KEY missing or placeholder). MRR shows zero."
      : "Stripe API call failed — showing the last cached snapshot. Refresh in a few minutes.";
  return (
    <div className="rounded-card border-rose bg-cloud text-rose border px-3 py-2 text-xs">
      {message}
    </div>
  );
}

function FunnelRow({ label, n, total }: { label: string; n: number; total: number }) {
  const pct = total === 0 ? "—" : `${Math.round((n / total) * 100)}%`;
  return (
    <tr>
      <td className="text-ink py-1.5">{label}</td>
      <td className="text-ink py-1.5 text-right tabular-nums">{n}</td>
      <td className="text-ash py-1.5 text-right tabular-nums">{pct}</td>
    </tr>
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

function gbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}£${(Math.abs(minor) / 100).toFixed(2)}`;
}

function fmtTime(d: Date): string {
  return d.toISOString().slice(11, 16) + " UTC";
}
