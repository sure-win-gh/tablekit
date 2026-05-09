import { eq } from "drizzle-orm";
import { ChevronRight, Webhook } from "lucide-react";
import Link from "next/link";

import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { organisations } from "@/lib/db/schema";
import { listSubscriptions } from "@/lib/webhooks/subscribe";

import { CreateSubscriptionForm, RevokeSubscriptionButton } from "./forms";

export const metadata = { title: "Webhooks · TableKit" };
export const dynamic = "force-dynamic";

// Owner-only Plus-tier webhook subscription management.
//
// Lists existing subscriptions, lets the owner register a new one
// (signing secret shown once), and revoke. Delivery + retry happen
// in PR6b; the delivery log + replay in PR6c — this PR only ships
// the registration surface.

export default async function WebhooksPage() {
  const { orgId } = await requireRole("owner");
  await requirePlan(orgId, "plus");

  const { subscriptions, plan } = await withUser(async (db) => {
    const [o] = await db
      .select({ plan: organisations.plan })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    const subs = await listSubscriptions(db, { organisationId: orgId });
    return { subscriptions: subs, plan: o?.plan ?? "free" };
  });

  if (!hasPlan(toPlan(plan), "plus")) {
    throw new Error("WebhooksPage: requirePlan failed open");
  }

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
        <span className="text-ink">Webhooks</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Webhook className="text-coral h-6 w-6" aria-hidden />
          Webhooks
        </h1>
        <p className="text-ash mt-1 text-sm">
          Outbound HTTPS endpoints we POST booking events to. Each subscription has a signing secret
          you use to verify the <code className="font-mono text-xs">X-TableKit-Signature</code>{" "}
          header. Active deliveries land in PR6b; for now this page registers the endpoints.
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Register a new endpoint</h2>
        <CreateSubscriptionForm />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">
          Subscriptions ({subscriptions.length})
        </h2>
        {subscriptions.length === 0 ? (
          <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
            No subscriptions yet. Register one above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {subscriptions.map((s) => (
              <li
                key={s.id}
                className="rounded-card border-hairline flex items-start justify-between gap-4 border bg-white p-4"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/organisation/webhooks/${s.id}`}
                      className="text-ink text-sm font-semibold hover:underline"
                    >
                      {s.label}
                    </Link>
                    <StatusBadge revokedAt={s.revokedAt} active={s.active} />
                  </div>
                  <p className="text-ash mt-1 font-mono text-xs break-all">{s.url}</p>
                  <p className="text-ash mt-1 text-xs">
                    Events:{" "}
                    {s.events
                      .map((e) => (
                        <code key={e} className="font-mono">
                          {e}
                        </code>
                      ))
                      .reduce<React.ReactNode[]>((acc, el, i) => {
                        if (i > 0) acc.push(", ");
                        acc.push(el);
                        return acc;
                      }, [])}
                  </p>
                  <p className="text-ash mt-1 text-xs">
                    Created {s.createdAt.toLocaleDateString("en-GB")}
                    {s.revokedAt ? ` · revoked ${s.revokedAt.toLocaleDateString("en-GB")}` : ""}
                  </p>
                </div>
                {s.revokedAt ? null : (
                  <RevokeSubscriptionButton subscriptionId={s.id} label={s.label} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusBadge({ revokedAt, active }: { revokedAt: Date | null; active: boolean }) {
  if (revokedAt) {
    return (
      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500">
        Revoked
      </span>
    );
  }
  if (!active) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        Paused
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
      Active
    </span>
  );
}
