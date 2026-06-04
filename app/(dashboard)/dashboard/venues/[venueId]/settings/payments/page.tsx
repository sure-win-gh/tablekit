import { requireRole } from "@/lib/auth/require-role";
import { getAccount } from "@/lib/stripe/connect";

import { BillingSection } from "../billing";

export const metadata = { title: "Payments · TableKit" };

export default async function PaymentsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ stripe?: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { venueId } = await params;
  const sp = await searchParams;

  // Stripe Connect state is org-scoped — one connected account per
  // organisation. The page lives under a venue URL, but every venue in
  // an org sees the same state.
  const stripeAccount = await getAccount(orgId);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Payments</h2>
        <p className="text-ash mt-0.5 text-sm">
          Connect Stripe so you can take deposits, card holds and no-show charges.
        </p>
      </div>

      <BillingSection
        venueId={venueId}
        account={
          stripeAccount
            ? {
                accountId: stripeAccount.accountId,
                chargesEnabled: stripeAccount.chargesEnabled,
                payoutsEnabled: stripeAccount.payoutsEnabled,
                detailsSubmitted: stripeAccount.detailsSubmitted,
              }
            : null
        }
        flash={sp.stripe ?? null}
      />
    </section>
  );
}
