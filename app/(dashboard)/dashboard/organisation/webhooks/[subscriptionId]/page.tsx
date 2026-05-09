import { and, eq } from "drizzle-orm";
import { ChevronRight, Webhook } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { webhookSubscriptions } from "@/lib/db/schema";
import { loadDeliveries, type DeliveryRow } from "@/lib/webhooks/deliveries-list";

import { ReplayButton } from "./forms";

export const metadata = { title: "Webhook deliveries · TableKit" };
export const dynamic = "force-dynamic";

// Owner-only Plus-tier delivery log + replay for one subscription.
//
// Reads via withUser → the new `webhook_deliveries_member_read` RLS
// policy (mig 0033) scopes results to the caller's org. Defence-in-
// depth: the helper also adds `organisation_id = ?` to the WHERE.

export default async function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ subscriptionId: string }>;
}) {
  const { orgId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const { subscriptionId } = await params;

  const { sub, deliveries } = await withUser(async (db) => {
    const [s] = await db
      .select({
        id: webhookSubscriptions.id,
        url: webhookSubscriptions.url,
        label: webhookSubscriptions.label,
        events: webhookSubscriptions.events,
        active: webhookSubscriptions.active,
        revokedAt: webhookSubscriptions.revokedAt,
      })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.id, subscriptionId),
          eq(webhookSubscriptions.organisationId, orgId),
        ),
      )
      .limit(1);
    if (!s) return { sub: null, deliveries: [] as DeliveryRow[] };
    const ds = await loadDeliveries(db, { subscriptionId: s.id, organisationId: orgId });
    return { sub: s, deliveries: ds };
  });

  if (!sub) notFound();

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href="/dashboard/organisation" className="hover:text-ink">
          Organisation
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href="/dashboard/organisation/webhooks" className="hover:text-ink">
          Webhooks
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">{sub.label}</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Webhook className="text-coral h-6 w-6" aria-hidden />
          {sub.label}
        </h1>
        <p className="text-ash mt-1 font-mono text-xs break-all">{sub.url}</p>
        <p className="text-ash mt-1 text-xs">
          Events: {sub.events.join(", ")}
          {sub.revokedAt ? " · revoked" : sub.active ? "" : " · paused"}
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">
          Recent deliveries ({deliveries.length})
        </h2>
        {deliveries.length === 0 ? (
          <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
            No deliveries yet. Bookings will queue events here once they fire.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deliveries.map((d) => (
              <li
                key={d.id}
                className="rounded-card border-hairline flex items-start justify-between gap-4 border bg-white p-4"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-ink font-mono text-xs">{d.eventType}</code>
                    <DeliveryStatusBadge status={d.status} lastStatus={d.lastStatus} />
                  </div>
                  <p className="text-ash mt-1 text-xs">
                    Attempts: {d.attempts}
                    {d.lastStatus !== null ? ` · last response ${d.lastStatus}` : ""}
                    {d.lastError ? ` · ${d.lastError}` : ""}
                  </p>
                  <p className="text-ash mt-1 text-xs">
                    Created {d.createdAt.toLocaleString("en-GB")}
                    {d.sentAt ? ` · settled ${d.sentAt.toLocaleString("en-GB")}` : ""}
                    {d.nextAttemptAt
                      ? ` · next attempt ${d.nextAttemptAt.toLocaleString("en-GB")}`
                      : ""}
                  </p>
                </div>
                {sub.active && !sub.revokedAt ? (
                  <ReplayButton deliveryId={d.id} subscriptionId={sub.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function DeliveryStatusBadge({
  status,
  lastStatus,
}: {
  status: string;
  lastStatus: number | null;
}) {
  if (status === "succeeded") {
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        {lastStatus ?? 200}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
        Failed
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      Pending
    </span>
  );
}
