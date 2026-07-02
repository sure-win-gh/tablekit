import { Empty, HBar, KpiTile, Section, gbp, pctStr } from "@/components/admin/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { getConnectFunnel } from "@/lib/server/admin/dashboard/metrics/connect-funnel";
import { getMrrSnapshot, type MrrSnapshot } from "@/lib/server/admin/dashboard/stripe-billing";

export const dynamic = "force-dynamic";

export default async function AdminFinancialsPage() {
  await requirePlatformAdmin();

  const [mrr, funnel] = await Promise.all([getMrrSnapshot(), getConnectFunnel(adminDb())]);

  const tiers = Object.entries(mrr.byTier).sort(([, a], [, b]) => b - a);
  const tierMax = tiers[0]?.[1] ?? 0;

  const funnelStages = [
    { label: "All organisations", n: funnel.totalOrgs },
    { label: "Connect account created", n: funnel.hasAccount },
    { label: "Details submitted", n: funnel.detailsSubmitted },
    { label: "Charges enabled", n: funnel.chargesEnabled },
    { label: "Payouts enabled", n: funnel.payoutsEnabled },
  ];

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

      <div className="grid grid-cols-3 gap-3">
        <KpiTile label="MRR" value={gbp(mrr.mrrMinor)} alert={mrr.degraded} />
        <KpiTile label="Active subscriptions" value={String(mrr.activeSubs)} />
        <KpiTile label="As of" value={mrr.asOf.toISOString().slice(11, 16) + " UTC"} />
      </div>

      <Section
        title="MRR by tier"
        description="Price lookup_key → monthly-normalised revenue."
        csvHref="/admin/export/financials"
      >
        {tiers.length === 0 ? (
          <Empty message="No active subscriptions." />
        ) : (
          <div className="flex flex-col gap-2">
            {tiers.map(([tier, minor]) => (
              <HBar
                key={tier}
                label={tier}
                value={minor}
                max={tierMax}
                display={gbp(minor)}
                sub={mrr.mrrMinor === 0 ? undefined : pctStr(minor / mrr.mrrMinor)}
                color="var(--color-coral)"
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Stripe Connect onboarding funnel"
        description="Where operators stall between signing up and taking deposits. The biggest step-drop is the thing to fix."
        csvHref="/admin/export/connect-funnel"
      >
        <div className="flex flex-col gap-2">
          {funnelStages.map((stage, i) => {
            const prev = funnelStages[i - 1];
            const drop =
              prev && prev.n > 0 && stage.n < prev.n ? `−${prev.n - stage.n} vs prev` : undefined;
            return (
              <HBar
                key={stage.label}
                label={stage.label}
                value={stage.n}
                max={funnel.totalOrgs}
                display={funnel.totalOrgs === 0 ? "—" : pctStr(stage.n / funnel.totalOrgs, 0)}
                sub={drop ?? `${stage.n} orgs`}
              />
            );
          })}
        </div>
      </Section>
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
