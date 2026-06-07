import { eq } from "drizzle-orm";
import { Building2, ChevronRight, CircleUser, CreditCard, Lock, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { requireRole } from "@/lib/auth/require-role";
import { getBillingContact, type BillingContact } from "@/lib/billing/contact";
import { PLAN_LABEL, PLAN_PRICE, SUBSCRIBED, fmtDate, fmtMoney } from "@/lib/billing/display";
import { withUser } from "@/lib/db/client";
import { billingSubscriptions, organisations, users, venues } from "@/lib/db/schema";
import { stripeEnabled } from "@/lib/stripe/client";

export const metadata = { title: "Account · TableKit" };

const BILLING_HREF = "/dashboard/organisation/billing";

// Settings → Account. A read-focused summary of plan, billing contact,
// messaging credit, organisation and the signed-in user — every state-changing
// action links out to the billing page (Stripe Checkout / Portal / top-ups) or
// the organisation/security pages. Sensitive billing detail is owner-only,
// mirroring the gating in organisation/page.tsx.
export default async function AccountPage() {
  const { userId, orgId, role } = await requireRole("host");
  const isOwner = role === "owner";

  const { org, sub, venueCount, me } = await withUser(async (db) => {
    const [o] = await db
      .select({
        name: organisations.name,
        slug: organisations.slug,
        plan: organisations.plan,
        creditPence: organisations.creditBalancePence,
      })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    const [s] = await db
      .select({
        status: billingSubscriptions.status,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.organisationId, orgId))
      .limit(1);
    const v = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.organisationId, orgId));
    const [u] = await db
      .select({ fullName: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return { org: o ?? null, sub: s ?? null, venueCount: v.length, me: u ?? null };
  });

  if (!org) throw new Error("AccountPage: no org under active session");

  const plan = org.plan;
  const isSubscribed = sub !== null && SUBSCRIBED.has(sub.status);
  const isPastDue = sub?.status === "past_due";
  const stripeOff = !stripeEnabled();
  const isPlus = hasPlan(toPlan(plan), "plus");
  const showCredit = !stripeOff && (isPlus || org.creditPence > 0);

  // Billing contact lives on the Stripe customer — owner-only, and only worth
  // fetching when Stripe is configured.
  const contact = isOwner && !stripeOff ? await getBillingContact(orgId) : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Account</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <CircleUser className="text-coral h-6 w-6" aria-hidden />
          Account
        </h1>
        <p className="text-ash mt-1 text-sm">
          Your plan, billing details and contact information. Payments are handled entirely by
          Stripe — we never see your card.
        </p>
      </header>

      {isPastDue && isOwner ? (
        <Link
          href={BILLING_HREF}
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
        {/* Plan & subscription */}
        <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Plan &amp; subscription</h2>
          <div className="flex items-center justify-between">
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
          {isOwner ? (
            <Link
              href={BILLING_HREF}
              className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
            >
              <CreditCard className="text-ash h-4 w-4" aria-hidden />
              {isSubscribed ? "Manage billing" : "Upgrade or manage billing"}
              <ChevronRight className="text-stone h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <p className="text-ash text-xs">Only owners can change the plan or payment method.</p>
          )}
        </section>

        {/* Billing contact — owner-only, sourced from Stripe */}
        {isOwner ? <BillingContactSection contact={contact} stripeOff={stripeOff} /> : null}

        {/* Messaging credit */}
        {isOwner && showCredit ? (
          <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
            <h2 className="text-ink text-sm font-semibold tracking-tight">Messaging credit</h2>
            <p className="text-ash text-sm">
              Prepaid balance for marketing SMS/WhatsApp, charged at cost. Transactional booking
              messages are never affected.
            </p>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ink text-lg font-semibold">{fmtMoney(org.creditPence)}</p>
                <p className="text-ash text-sm">available credit</p>
              </div>
              <Link href={BILLING_HREF} className="text-ash hover:text-ink text-sm">
                Top up →
              </Link>
            </div>
          </section>
        ) : null}

        {/* Organisation */}
        <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Organisation</h2>
          <dl className="divide-hairline -mx-1 divide-y text-sm">
            <Row label="Name" value={org.name} />
            <Row label="Slug" value={org.slug} mono />
            <Row label="Plan" value={PLAN_LABEL[plan] ?? plan} />
            <Row label="Venues" value={String(venueCount)} />
          </dl>
          <Link
            href="/dashboard/organisation"
            className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
          >
            <Building2 className="text-ash h-4 w-4" aria-hidden />
            Manage organisation
            <ChevronRight className="text-stone h-4 w-4" aria-hidden />
          </Link>
        </section>

        {/* Your details */}
        <section className="rounded-card border-hairline flex h-full flex-col gap-2 border bg-white p-5">
          <h2 className="text-ink text-sm font-semibold tracking-tight">Your details</h2>
          <dl className="divide-hairline -mx-1 divide-y text-sm">
            <Row label="Name" value={me?.fullName ?? "—"} />
            <Row label="Email" value={me?.email ?? "—"} />
            <Row label="Role" value={role} />
          </dl>
          <Link
            href="/dashboard/settings/security"
            className="rounded-card border-hairline hover:border-ink inline-flex w-fit items-center gap-2 border bg-white px-3 py-2 text-sm transition"
          >
            <Lock className="text-ash h-4 w-4" aria-hidden />
            Security &amp; two-factor
            <ChevronRight className="text-stone h-4 w-4" aria-hidden />
          </Link>
        </section>
      </div>
    </main>
  );
}

function BillingContactSection({
  contact,
  stripeOff,
}: {
  contact: BillingContact | null;
  stripeOff: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ink text-sm font-semibold tracking-tight">Billing contact</h2>
      {stripeOff ? (
        <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
          Billing isn&apos;t configured on this environment yet.
        </p>
      ) : contact === null ? (
        <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
          No billing details yet — they&apos;re added when you subscribe.
        </p>
      ) : (
        <>
          <dl className="divide-hairline -mx-1 divide-y text-sm">
            <Row label="Name" value={contact.name ?? "—"} />
            <Row label="Email" value={contact.email ?? "—"} />
            <Row label="Phone" value={contact.phone ?? "—"} />
            <Row
              label="Address"
              value={contact.addressLines.length > 0 ? contact.addressLines.join(", ") : "—"}
            />
            <Row label="VAT / tax ID" value={contact.taxId ?? "—"} />
          </dl>
          <p className="text-ash text-xs">
            Edit these in the{" "}
            <Link href={BILLING_HREF} className="text-ash hover:text-ink underline">
              Stripe billing portal
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-ash">{label}</dt>
      <dd className={mono ? "text-charcoal font-mono" : "text-charcoal"}>{value}</dd>
    </div>
  );
}
