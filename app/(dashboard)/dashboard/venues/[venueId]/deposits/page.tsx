import { asc, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { depositRules, services, stripeAccounts } from "@/lib/db/schema";

import { DepositRuleRow, NewDepositRuleForm } from "./forms";

export const metadata = {
  title: "Deposits · TableKit",
};

export default async function DepositsPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { orgId } = await requireRole("manager");
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
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-neutral-900">Deposit rules</h2>
        <p className="text-sm text-neutral-500">
          The most-specific matching rule wins — a service-specific rule beats a wildcard, narrower
          day-of-week beats broader, narrower party range beats open, most recently created breaks
          ties. Bookings that match a rule collect a deposit via the widget; host-created bookings
          skip deposits.
        </p>
      </div>

      <div className="flex flex-col">
        {rules.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
            No rules yet. Add one below to start collecting deposits on widget bookings.
          </p>
        ) : (
          rules.map((r) => (
            <DepositRuleRow
              key={r.id}
              rule={r}
              serviceName={r.serviceId ? (servicesById.get(r.serviceId) ?? null) : null}
              venueId={venueId}
            />
          ))
        )}
      </div>

      <NewDepositRuleForm
        venueId={venueId}
        services={serviceOptions}
        chargesEnabled={chargesEnabled}
      />
    </section>
  );
}
