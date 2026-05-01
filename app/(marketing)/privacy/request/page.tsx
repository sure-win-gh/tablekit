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
        <p className="text-coral text-xs font-semibold tracking-wider uppercase">Privacy</p>
        <h1 className="text-ink mt-2 text-3xl font-bold tracking-tight">
          Submit a privacy request
        </h1>
        {org ? (
          <p className="text-ash mt-1.5 text-sm">
            This request will be routed to{" "}
            <span className="text-ink font-semibold">{org.name}</span> — they&apos;ll respond within
            one calendar month under UK GDPR.
          </p>
        ) : (
          <p className="text-ash mt-1.5 text-sm">
            We process bookings on behalf of independent venues. Please ask the venue you booked
            with for the request link, or use the form below if you have their organisation
            identifier.
          </p>
        )}
      </header>

      {org ? (
        <DsarRequestForm orgSlug={org.slug} orgName={org.name} />
      ) : (
        <section className="rounded-card border-hairline bg-cloud text-charcoal border p-6 text-sm">
          <h2 className="text-ink text-base font-bold tracking-tight">No organisation selected</h2>
          <p className="mt-1.5">
            Privacy requests need to reach the venue that took the booking — they hold and control
            your data, we just process it on their behalf. Reply to your booking confirmation email
            or check the venue&apos;s website for the request link.
          </p>
          <p className="mt-3">
            Still stuck? Email{" "}
            <Link
              href="mailto:privacy@tablekit.uk"
              className="text-ink hover:text-coral font-semibold underline underline-offset-4"
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
