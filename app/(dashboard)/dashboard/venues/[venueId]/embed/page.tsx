import { eq } from "drizzle-orm";
import { ChevronRight, Code2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

import { CopyBlock } from "./forms";

export const metadata = { title: "Embed widget · TableKit" };

export default async function EmbedSnippetPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  await requireRole("manager");
  const { venueId } = await params;

  const venue = await withUser(async (db) => {
    const [row] = await db
      .select({ id: venues.id, name: venues.name, slug: venues.slug })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return row;
  });
  if (!venue) notFound();

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "https://book.tablekit.uk";
  const loaderUrl = `${appUrl}/widget.js`;
  // Prefer the slug everywhere user-visible — short, memorable, the
  // form the public 308 redirect normalises to. UUID stays as the
  // fallback when the operator hasn't picked one yet.
  const publicId = venue.slug ?? venue.id;
  const hostedUrl = `${appUrl}/book/${publicId}`;

  const snippet = `<script
  src="${loaderUrl}"
  data-venue-id="${publicId}"
  async
></script>`;

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href={`/dashboard/venues/${venueId}`} className="hover:text-ink">
          {venue.name}
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Embed widget</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Code2 className="text-coral h-6 w-6" aria-hidden />
          Embed widget
        </h1>
        <p className="text-ash mt-1 max-w-2xl text-sm">
          Two ways to take bookings off your dashboard. The embed mounts the booking flow inside an
          iframe on your own site; the hosted link is a standalone page you can drop into Instagram,
          QR codes, or Google Business Profile.
        </p>
        {!venue.slug ? (
          <p className="rounded-card border-hairline bg-cloud text-charcoal mt-3 max-w-2xl border px-3 py-2 text-xs">
            Tip: this venue is using its UUID in the URL. Pick a short slug in{" "}
            <Link
              href={`/dashboard/venues/${venueId}/settings`}
              className="text-coral font-medium hover:underline"
            >
              venue settings
            </Link>{" "}
            to get a friendlier link like{" "}
            <code className="rounded bg-white px-1 py-0.5">{appUrl}/book/jane-cafe</code>. Old QR
            codes pointing at the UUID keep working.
          </p>
        ) : null}
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">Embed snippet</h2>
        <p className="text-charcoal text-sm">
          Paste this one line of HTML into your site where you want the booking widget to appear.
          The script lazily loads an iframe sized to its contents — no styling required on your end.
        </p>
        <CopyBlock value={snippet} ariaLabel="Embed snippet HTML" multiline />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">
          Hosted booking link
        </h2>
        <p className="text-charcoal text-sm">
          Direct link to a standalone booking page. Use it in your Instagram bio, on a QR code at
          the host stand, or as the action URL on your Google Business Profile.
        </p>
        <CopyBlock value={hostedUrl} ariaLabel="Hosted booking URL" />
        <Link
          href={hostedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-coral self-start text-xs hover:underline"
        >
          Open in new tab →
        </Link>
      </section>
    </main>
  );
}
