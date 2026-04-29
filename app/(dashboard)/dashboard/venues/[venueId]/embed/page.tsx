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
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return row;
  });
  if (!venue) notFound();

  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "https://book.tablekit.uk";
  const loaderUrl = `${appUrl}/widget.js`;
  const hostedUrl = `${appUrl}/book/${venue.id}`;

  const snippet = `<script
  src="${loaderUrl}"
  data-venue-id="${venue.id}"
  async
></script>`;

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <Link href={`/dashboard/venues/${venueId}`} className="hover:text-ink">
          {venue.name}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="text-ink">Embed widget</span>
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-ink">
          <Code2 className="h-6 w-6 text-coral" aria-hidden />
          Embed widget
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ash">
          Two ways to take bookings off your dashboard. The embed mounts the booking
          flow inside an iframe on your own site; the hosted link is a standalone
          page you can drop into Instagram, QR codes, or Google Business Profile.
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ash">
          Embed snippet
        </h2>
        <p className="text-sm text-charcoal">
          Paste this one line of HTML into your site where you want the booking
          widget to appear. The script lazily loads an iframe sized to its
          contents — no styling required on your end.
        </p>
        <CopyBlock value={snippet} ariaLabel="Embed snippet HTML" multiline />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ash">
          Hosted booking link
        </h2>
        <p className="text-sm text-charcoal">
          Direct link to a standalone booking page. Use it in your Instagram bio,
          on a QR code at the host stand, or as the action URL on your Google
          Business Profile.
        </p>
        <CopyBlock value={hostedUrl} ariaLabel="Hosted booking URL" />
        <Link
          href={hostedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-xs text-coral hover:underline"
        >
          Open in new tab →
        </Link>
      </section>
    </main>
  );
}
