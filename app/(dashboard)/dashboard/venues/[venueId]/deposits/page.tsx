import { asc, eq } from "drizzle-orm";

import { LockedFeature } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { depositRules, services, stripeAccounts } from "@/lib/db/schema";

import { DepositRuleRow, NewDepositRuleForm } from "./forms";

export const metadata = {
  title: "Deposits · TableKit",
};

export default async function DepositsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { orgId } = await requireRole("manager");
  const plan = await getPlan(orgId);
  if (isLocked(plan, "deposits")) {
    return <LockedFeature feature="deposits" currentPlan={plan} />;
  }
  const { venueId } = await params;

  const { rules, serviceOptions, chargesEnabled } = await withUser(async (db) => {
    const rulesRows = await db
      .select({
        id: depositRules.id,
        serviceId: depositRules.serviceId,
        minParty: depositRules.minParty,
        maxParty: depositRules.maxParty,
        dayOfWeek: depositRules.dayOfWeek,
        kind: depositRules.kind,
        amountMinor: depositRules.amountMinor,
        refundWindowHours: depositRules.refundWindowHours,
      })
      .from(depositRules)
      .where(eq(depositRules.venueId, venueId))
      .orderBy(asc(depositRules.createdAt));

    const serviceRows = await db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(eq(services.venueId, venueId))
      .orderBy(asc(services.name));

    // Connect state is org-scoped; the billing section in settings is
    // the source of truth. We mirror the chargesEnabled flag here so we
    // can gate the form without an extra round-trip.
    const [account] = await db
      .select({ chargesEnabled: stripeAccounts.chargesEnabled })
      .from(stripeAccounts)
      .where(eq(stripeAccounts.organisationId, orgId))
      .limit(1);

    return {
      rules: rulesRows,
      serviceOptions: serviceRows,
      chargesEnabled: account?.chargesEnabled ?? false,
    };
  });

  const servicesById = new Map(serviceOptions.map((s) => [s.id, s.name]));

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Deposit rules</h2>
        <p className="text-ash mt-0.5 text-sm">
          Widget bookings that match a rule collect a deposit (or card hold) at booking time;
          host-created bookings never do.
        </p>
      </div>

      {rules.length === 0 ? (
        <p className="border-hairline text-ash rounded-card border border-dashed bg-white p-6 text-center text-sm">
          No rules yet — add one below to start collecting deposits on widget bookings.
        </p>
      ) : (
        <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
          {rules.map((r) => (
            <DepositRuleRow
              key={r.id}
              rule={r}
              serviceName={r.serviceId ? (servicesById.get(r.serviceId) ?? null) : null}
              venueId={venueId}
            />
          ))}
        </div>
      )}

      <NewDepositRuleForm
        venueId={venueId}
        services={serviceOptions}
        chargesEnabled={chargesEnabled}
        startOpen={rules.length === 0}
      />

      {rules.length > 1 ? (
        <p className="text-ash text-xs">
          When several rules match a booking, the most specific wins: a service-specific rule beats
          &ldquo;All services&rdquo;, fewer days beats more days, a narrower party range beats an
          open one, and the newest rule breaks any remaining tie.
        </p>
      ) : null}
    </section>
  );
}
