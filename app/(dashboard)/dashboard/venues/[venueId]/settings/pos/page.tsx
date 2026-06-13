import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { isLightspeedConfigured } from "@/lib/pos/lightspeed/oauth";
import { loadUnmatchedOrders, loadVenuePosConnections } from "@/lib/pos/queries";
import { isSquareConfigured } from "@/lib/pos/square/oauth";

import { PosConnectionSection } from "./pos-connection-section";
import { UnmatchedOrders } from "./unmatched-orders";

export const metadata = { title: "POS · TableKit" };

export default async function PosSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ square?: string; lightspeed?: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { venueId } = await params;
  const sp = await searchParams;

  // Plus-tier feature. A Free/Core org gets a clear upsell rather than the UI.
  let plusOk = true;
  try {
    await requirePlan(orgId, "plus");
  } catch (e) {
    if (e instanceof InsufficientPlanError) plusOk = false;
    else throw e;
  }

  if (!plusOk) {
    return (
      <section className="flex max-w-xl flex-col gap-2">
        <h2 className="text-ink text-xl font-bold tracking-tight">Till / POS</h2>
        <p className="text-ash text-sm">
          Connecting your till to attach spend to guest profiles is a Plus-tier feature.
        </p>
      </section>
    );
  }

  const [connections, unmatched] = await Promise.all([
    loadVenuePosConnections(venueId),
    loadUnmatchedOrders(venueId),
  ]);

  return (
    <section className="flex flex-col gap-8">
      <PosConnectionSection
        venueId={venueId}
        connections={connections}
        squareConfigured={isSquareConfigured()}
        lightspeedConfigured={isLightspeedConfigured()}
        flash={sp.square ?? sp.lightspeed ?? null}
      />
      <UnmatchedOrders venueId={venueId} orders={unmatched} />
    </section>
  );
}
