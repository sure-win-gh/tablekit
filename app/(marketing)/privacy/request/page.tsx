import { eq } from "drizzle-orm";
import Link from "next/link";

import { organisations } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { DsarRequestForm } from "./forms";

export const metadata = { title: "Privacy request · TableKit" };
export const dynamic = "force-dynamic";

type SearchParams = { org?: string };

// Resolves ?org=<slug> to a display name on the server so the form
// header reads "Submit a privacy request to <Acme Café>" rather than
// "to acme-cafe-london". If no slug is provided, render guidance
// instead of the form.

export default async function PrivacyRequestPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { org: slug } = await searchParams;

  const org = slug
    ? (
        await adminDb()
          .select({ id: organisations.id, name: organisations.name, slug: organisations.slug })
          .from(organisations)
          .where(eq(organisations.slug, slug))
          .limit(1)
      )[0]
    : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-coral">Privacy</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Submit a privacy request</h1>
        {org ? (
          <p className="mt-1.5 text-sm text-ash">
            This request will be routed to <span className="font-semibold text-ink">{org.name}</span>{" "}
            — they&apos;ll respond within one calendar month under UK GDPR.
          </p>
        ) : (
          <p className="mt-1.5 text-sm text-ash">
            We process bookings on behalf of independent venues. Please ask the venue you booked
            with for the request link, or use the form below if you have their organisation
            identifier.
          </p>
        )}
      </header>

      {org ? (
        <DsarRequestForm orgSlug={org.slug} orgName={org.name} />
      ) : (
        <section className="rounded-card border border-hairline bg-cloud p-6 text-sm text-charcoal">
          <h2 className="text-base font-bold tracking-tight text-ink">No organisation selected</h2>
          <p className="mt-1.5">
            Privacy requests need to reach the venue that took the booking — they hold and control
            your data, we just process it on their behalf. Reply to your booking confirmation email
            or check the venue&apos;s website for the request link.
          </p>
          <p className="mt-3">
            Still stuck? Email{" "}
            <Link
              href="mailto:privacy@tablekit.uk"
              className="font-semibold text-ink underline underline-offset-4 hover:text-coral"
            >
              privacy@tablekit.uk
            </Link>{" "}
            and we&apos;ll route you.
          </p>
        </section>
      )}
    </main>
  );
}
