import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { getAccount } from "@/lib/stripe/connect";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

import { BillingSection } from "./billing";
import { VenueSettingsForm } from "./form";

export const metadata = {
  title: "Settings · TableKit",
};

export default async function VenueSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ stripe?: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { venueId } = await params;
  const sp = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        venueType: venues.venueType,
        timezone: venues.timezone,
        locale: venues.locale,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  // Stripe Connect state is org-scoped — one connected account per
  // organisation (D1 in the phase plan). The billing section is
  // per-venue in the sense that it lives under a venue URL, but every
  // venue in an org sees the same state.
  const stripeAccount = await getAccount(orgId);

  return (
    <section className="flex flex-col gap-8">
      <div>
        <p className="mb-6 text-sm text-ash">
          Venue type is <span className="font-mono text-charcoal">{venue.venueType}</span> —
          changing type isn&apos;t supported yet.
        </p>

        <VenueSettingsForm
          venueId={venue.id}
          name={venue.name}
          timezone={venue.timezone}
          locale={venue.locale}
        />
      </div>

      <BillingSection
        venueId={venue.id}
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
