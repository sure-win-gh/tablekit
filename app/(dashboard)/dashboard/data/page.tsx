import { and, eq, isNull, sql } from "drizzle-orm";
import { ChevronRight, Database, Download, Lock } from "lucide-react";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { bookings, guests } from "@/lib/db/schema";

export const metadata = { title: "Data · TableKit" };

// Settings → Data: operator-facing export landing page. PR1 covers
// inline downloads of the two largest entities (guests, bookings)
// in CSV + JSON. Payments + messages + a full-org backup zip land
// in PR2 along with the export-jobs table and signed URLs.

export default async function DataPage() {
  const { orgId, role } = await requireRole("host");
  const canExport = role === "owner" || role === "manager";

  // Filter explicitly by orgId — RLS scopes to every org the caller
  // is a member of, so a dual-org user would otherwise see combined
  // counts. Same defence-in-depth as the export readers.
  const counts = await withUser(async (db) => {
    const [g] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(guests)
      .where(and(eq(guests.organisationId, orgId), isNull(guests.erasedAt)));
    const [b] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(eq(bookings.organisationId, orgId));
    return { guests: g?.n ?? 0, bookings: b?.n ?? 0 };
  });

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="text-ink">Data</span>
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-ink">
          <Database className="h-6 w-6 text-coral" aria-hidden />
          Data
        </h1>
        <p className="mt-1 text-sm text-ash">
          Export your guests and bookings in CSV or JSON. Encrypted personal data is decrypted in
          the export — only members of this organisation can run it. Every export is recorded in
          the audit log.
        </p>
      </header>

      {!canExport ? (
        <p className="mt-6 flex items-center gap-2 rounded-card border border-hairline bg-cloud p-4 text-sm text-ash">
          <Lock className="h-4 w-4" aria-hidden />
          Exporting requires manager or owner role. Ask the account owner to run an export.
        </p>
      ) : (
        <section className="mt-6 grid gap-4 md:grid-cols-2">
          <ExportCard
            title="Guests"
            entity="guests"
            count={counts.guests}
            description="One row per guest, excluding erased records. Includes decrypted email, phone, and last name."
            disabled={!canExport}
          />
          <ExportCard
            title="Bookings"
            entity="bookings"
            count={counts.bookings}
            description="One row per booking with venue, service, area, guest first name and email, party size, status, and source."
            disabled={!canExport}
          />
        </section>
      )}

      <section className="mt-10 flex flex-col gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Coming soon</h2>
        <p className="text-sm text-ash">
          Messages, payments, and a single-zip full-organisation backup land in the next release.
          Imports from OpenTable, ResDiary, and SevenRooms follow on the Plus plan.
        </p>
      </section>
    </main>
  );
}

function ExportCard({
  title,
  entity,
  count,
  description,
  disabled,
}: {
  title: string;
  entity: "guests" | "bookings";
  count: number;
  description: string;
  disabled: boolean;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-card border border-hairline bg-white p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold tracking-tight text-ink">{title}</h3>
        <span className="text-xs text-ash">
          {count.toLocaleString("en-GB")} {count === 1 ? "row" : "rows"}
        </span>
      </header>
      <p className="text-sm text-ash">{description}</p>
      <div className="mt-auto flex gap-2">
        <DownloadLink entity={entity} format="csv" disabled={disabled} />
        <DownloadLink entity={entity} format="json" disabled={disabled} />
      </div>
    </article>
  );
}

function DownloadLink({
  entity,
  format,
  disabled,
}: {
  entity: "guests" | "bookings";
  format: "csv" | "json";
  disabled: boolean;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-input border border-hairline px-3 py-1.5 text-sm transition";
  if (disabled) {
    return (
      <span className={`${base} cursor-not-allowed text-mute`} aria-disabled>
        <Download className="h-4 w-4" aria-hidden />
        {format.toUpperCase()}
      </span>
    );
  }
  return (
    <a
      href={`/dashboard/data/export/${entity}?format=${format}`}
      className={`${base} bg-white text-ink hover:border-ink`}
      // download attribute is informational — Content-Disposition on
      // the response sets the actual filename (with today's date).
      download
    >
      <Download className="h-4 w-4" aria-hidden />
      {format.toUpperCase()}
    </a>
  );
}
