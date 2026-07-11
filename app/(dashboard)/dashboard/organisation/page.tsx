import { eq } from "drizzle-orm";
import {
  Building2,
  ChevronRight,
  CreditCard,
  KeyRound,
  TriangleAlert,
  UserPlus,
  Webhook,
} from "lucide-react";
import Link from "next/link";

import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { requireRole } from "@/lib/auth/require-role";
import { getUsageSummary, type UsageSummary } from "@/lib/billing/usage-summary";
import { withUser } from "@/lib/db/client";
import { billingSubscriptions, organisations, venues } from "@/lib/db/schema";

import { GroupCrmToggle } from "./forms";

const CHANNEL_LABEL: Record<string, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export const metadata = { title: "Organisation · TableKit" };

// Owner-level org settings. Single setting today (group CRM opt-in)
// — billing, team, and DPA download will land here over time.
//
// Read access is open to all members; writes (server actions) require
// owner role per requireRole inside the action.

export default async function OrganisationPage() {
  const { role } = await requireRole("host");
  const isOwner = role === "owner";

  const { org, venueCount, usage, billingPastDue } = await withUser(async (db) => {
    const [o] = await db
      .select({
        id: organisations.id,
        name: organisations.name,
        slug: organisations.slug,
        plan: organisations.plan,
        groupCrmEnabled: organisations.groupCrmEnabled,
      })
      .from(organisations)
      .limit(1);
    if (!o) return { org: null, venueCount: 0, usage: null, billingPastDue: false };
    const v = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.organisationId, o.id));
    const usage = await getUsageSummary(db, o.id, new Date());
    const [sub] = await db
      .select({ status: billingSubscriptions.status })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organisationId, o.id))
      .limit(1);
    return { org: o, venueCount: v.length, usage, billingPastDue: sub?.status === "past_due" };
  });

  if (!org) {
    throw new Error("OrganisationPage: no org under active session");
  }

  const isPlus = hasPlan(toPlan(org.plan), "plus");

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Organisation</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Building2 className="text-coral h-6 w-6" aria-hidden />
          {org.name}
        </h1>
        <p className="text-ash mt-1 text-sm">
          {org.plan} plan · slug <span className="font-mono">{org.slug}</span> · {venueCount}{" "}
          {venueCount === 1 ? "venue" : "venues"}
        </p>
      </header>

      {billingPastDue && isOwner ? (
        <Link
          href="/dashboard/organisation/billing"
          className="rounded-card mt-4 flex items-start gap-2 border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 transition hover:border-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            There&apos;s a problem with your last payment. Update your card on the Billing page to
            keep your plan.
          </span>
        </Link>
      ) : null}

      <div className="mt-6 grid items-stretch gap-6 md:grid-cols-2">
        {isOwner ? (
          <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
            <h2 className="text-ink text-sm font-semibold tracking-tight">Billing</h2>
            <p className="text-ash text-sm">
              Your subscription plan and payment method, managed securely through Stripe.
            </p>
            <Link
              href="/dashboard/organisation/billing"
              className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
            >
              <CreditCard className="text-ash h-4 w-4" aria-hidden />
              Manage billing
              <ChevronRight className="text-stone h-4 w-4" aria-hidden />
            </Link>
          </section>
        ) : null}

        <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Group CRM</h2>
          <p className="text-ash text-sm">
            When enabled, operators with access to multiple venues see a single guest list across
            all of them at <span className="font-mono">/dashboard/guests</span>. Marketing consent
            stays per-venue — opting in at one venue doesn&apos;t opt the guest in at another. Each
            venue&apos;s own guest list is always available from that venue&apos;s sidebar
            regardless of this setting.
          </p>
          {!isPlus ? (
            <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
              Group CRM is a Plus-tier feature. The CRM (per-venue and cross-venue) requires the
              Plus plan; upgrade from the Billing page to enable it.
            </p>
          ) : venueCount < 2 ? (
            <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
              With one venue this aggregate view is the same as the per-venue CRM, so there&apos;s
              nothing to enable yet. Add another venue and the toggle becomes meaningful.
            </p>
          ) : null}
          <GroupCrmToggle
            initialEnabled={org.groupCrmEnabled}
            disabled={!isOwner || !isPlus || venueCount < 2}
            ownerOnlyHint={!isOwner}
          />
        </section>

        <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Team</h2>
          <p className="text-ash text-sm">
            Members of this organisation and pending invitations. Owners can invite teammates by
            email.
          </p>
          <Link
            href="/dashboard/organisation/team"
            className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
          >
            <UserPlus className="text-ash h-4 w-4" aria-hidden />
            Manage team
            <ChevronRight className="text-stone h-4 w-4" aria-hidden />
          </Link>
        </section>

        {isPlus && isOwner ? (
          <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
            <h2 className="text-ink text-sm font-semibold tracking-tight">API access</h2>
            <p className="text-ash text-sm">
              Issue Bearer tokens for the public REST API at{" "}
              <span className="font-mono">api.tablekitapp.com/v1</span>. Owner-only.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/dashboard/organisation/api-keys"
                className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
              >
                <KeyRound className="text-ash h-4 w-4" aria-hidden />
                Manage API keys
                <ChevronRight className="text-stone h-4 w-4" aria-hidden />
              </Link>
              <Link
                href="/dashboard/organisation/webhooks"
                className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
              >
                <Webhook className="text-ash h-4 w-4" aria-hidden />
                Manage webhooks
                <ChevronRight className="text-stone h-4 w-4" aria-hidden />
              </Link>
            </div>
          </section>
        ) : null}

        {usage ? <UsageSection usage={usage} /> : null}
      </div>
    </main>
  );
}

function fmtCost(pence: number): string {
  return pence === 0 ? "£0.00" : `£${(pence / 100).toFixed(2)}`;
}

// Messaging usage this month — send volume + estimated pass-through cost
// per channel. SMS/WhatsApp are billed at cost; email is free.
function UsageSection({ usage }: { usage: UsageSummary }) {
  const total = usage.rows.reduce((s, r) => s + r.count, 0);
  return (
    <section className="flex flex-col gap-2 md:col-span-2">
      <h2 className="text-ink text-sm font-semibold tracking-tight">Messaging usage</h2>
      <p className="text-ash text-sm">
        Sends this month ({usage.period}). SMS and WhatsApp are billed at cost; email is free.
        Estimated — reconciled against the provider invoice.
      </p>
      {total === 0 ? (
        <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
          No messages sent yet this month.
        </p>
      ) : (
        <div className="rounded-card border-hairline overflow-hidden border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
              <tr>
                <th className="px-4 py-2.5">Channel</th>
                <th className="px-4 py-2.5">Sends</th>
                <th className="px-4 py-2.5">Est. cost</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y">
              {usage.rows.map((r) => (
                <tr key={r.channel}>
                  <td className="text-ink px-4 py-3">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="text-charcoal px-4 py-3">{r.count}</td>
                  <td className="text-charcoal px-4 py-3">{fmtCost(r.costPence)}</td>
                </tr>
              ))}
              <tr className="bg-cloud/40 font-semibold">
                <td className="text-ink px-4 py-3">Total</td>
                <td className="text-ink px-4 py-3">{total}</td>
                <td className="text-ink px-4 py-3">{fmtCost(usage.totalCostPence)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
