import { eq } from "drizzle-orm";
import { ChevronRight, CreditCard, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";
import { billingSubscriptions, organisations } from "@/lib/db/schema";
import { withUser } from "@/lib/db/client";
import { stripeEnabled } from "@/lib/stripe/client";

import { openPortal, startCheckout } from "./billing-actions";

export const metadata = { title: "Billing · TableKit" };

const PLAN_LABEL: Record<string, string> = { free: "Free", core: "Core", plus: "Plus" };
const PLAN_PRICE: Record<string, string> = {
  core: "£19/month",
  plus: "£39/month",
};

// Statuses where the org still has access (past_due keeps access during
// Stripe's dunning retries).
const SUBSCRIBED = new Set(["active", "trialing", "past_due"]);

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// Owner-only billing page. Plan upgrades go through hosted Stripe
// Checkout; managing/cancelling an existing subscription goes through the
// hosted Customer Portal. organisations.plan is authoritative and only
// ever set by the subscription webhook — never here.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { orgId } = await requireRole("owner");
  const { checkout } = await searchParams;

  const { plan, sub } = await withUser(async (db) => {
    const [o] = await db
      .select({ plan: organisations.plan })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    const [s] = await db
      .select({
        status: billingSubscriptions.status,
        plan: billingSubscriptions.plan,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organisationId, orgId))
      .limit(1);
    return { plan: o?.plan ?? "free", sub: s ?? null };
  });

  const isSubscribed = sub !== null && SUBSCRIBED.has(sub.status);
  const isPastDue = sub?.status === "past_due";
  const stripeOff = !stripeEnabled();

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard/organisation" className="hover:text-ink">
          Organisation
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Billing</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <CreditCard className="text-coral h-6 w-6" aria-hidden />
          Billing
        </h1>
        <p className="text-ash mt-1 text-sm">
          Your subscription plan and payment method. Cards are handled entirely by Stripe — we never
          see them.
        </p>
      </header>

      {checkout === "success" ? (
        <p className="rounded-card mt-4 border border-green-600/30 bg-green-50 p-3 text-sm text-green-800">
          Payment received. Your plan updates within a few seconds of Stripe confirming it — refresh
          if it&apos;s not shown yet.
        </p>
      ) : checkout === "cancelled" ? (
        <p className="rounded-card border-hairline bg-cloud text-ash mt-4 border p-3 text-sm">
          Checkout cancelled — no change to your plan.
        </p>
      ) : null}

      {isPastDue ? (
        <p className="rounded-card mt-4 flex items-start gap-2 border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            There&apos;s a problem with your last payment. Stripe will retry automatically — update
            your card from &ldquo;Manage billing&rdquo; to avoid losing access.
          </span>
        </p>
      ) : null}

      <section className="mt-6 flex flex-col gap-2">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Current plan</h2>
        <div className="rounded-card border-hairline flex items-center justify-between border bg-white p-4">
          <div>
            <p className="text-ink text-lg font-semibold">{PLAN_LABEL[plan] ?? plan}</p>
            <p className="text-ash text-sm">
              {plan === "free"
                ? "Up to 50 bookings/month, no Plus features."
                : `${PLAN_PRICE[plan] ?? ""}${
                    isSubscribed && sub
                      ? sub.cancelAtPeriodEnd
                        ? ` · cancels on ${fmtDate(sub.currentPeriodEnd)}`
                        : ` · renews on ${fmtDate(sub.currentPeriodEnd)}`
                      : ""
                  }`}
            </p>
          </div>
        </div>
      </section>

      {stripeOff ? (
        <p className="rounded-card border-hairline bg-cloud text-ash mt-6 border p-3 text-xs">
          Billing isn&apos;t configured on this environment yet.
        </p>
      ) : isSubscribed ? (
        <section className="mt-6 flex flex-col gap-2">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Manage</h2>
          <p className="text-ash text-sm">
            Change your card, switch between Core and Plus, or cancel — all through Stripe&apos;s
            secure portal.
          </p>
          <form action={openPortal}>
            <button
              type="submit"
              className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
            >
              Manage billing
              <ChevronRight className="text-stone h-4 w-4" aria-hidden />
            </button>
          </form>
        </section>
      ) : (
        <section className="mt-6 flex flex-col gap-2">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Upgrade</h2>
          <p className="text-ash text-sm">
            Unlock unlimited bookings, deposits and Reserve with Google (Core), or multi-venue, the
            AI enquiry handler and marketing (Plus).
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={startCheckout.bind(null, "core")}>
              <button
                type="submit"
                className="rounded-card bg-ink hover:bg-charcoal inline-flex w-fit items-center gap-2 px-3 py-2 text-sm font-medium text-white transition"
              >
                Upgrade to Core — £19/mo
              </button>
            </form>
            <form action={startCheckout.bind(null, "plus")}>
              <button
                type="submit"
                className="rounded-card border-ink text-ink hover:bg-cloud inline-flex w-fit items-center gap-2 border px-3 py-2 text-sm font-medium transition"
              >
                Upgrade to Plus — £39/mo
              </button>
            </form>
          </div>
        </section>
      )}
    </main>
  );
}
