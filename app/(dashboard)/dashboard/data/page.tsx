import { and, eq, isNull, sql } from "drizzle-orm";
import { ChevronRight, Database, Download, Lock } from "lucide-react";
import Link from "next/link";

import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { bookings, guests, organisations } from "@/lib/db/schema";

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
  const { counts, isPlus } = await withUser(async (db) => {
    const [g] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(guests)
      .where(and(eq(guests.organisationId, orgId), isNull(guests.erasedAt)));
    const [b] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(eq(bookings.organisationId, orgId));
    const [o] = await db
      .select({ plan: organisations.plan })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    return {
      counts: { guests: g?.n ?? 0, bookings: b?.n ?? 0 },
      isPlus: o ? hasPlan(toPlan(o.plan), "plus") : false,
    };
  });
  // Both exports decrypt PII (guests: full record; bookings: joined
  // guest_email per row) so both are CRM-tier features.
  const canExportData = canExport && isPlus;

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Data</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Database className="text-coral h-6 w-6" aria-hidden />
          Data
        </h1>
        <p className="text-ash mt-1 text-sm">
          Export your guests and bookings in CSV or JSON. Encrypted personal data is decrypted in
          the export — only members of this organisation can run it. Every export is recorded in the
          audit log.
        </p>
      </header>

      {!canExport ? (
        <p className="rounded-card border-hairline bg-cloud text-ash mt-6 flex items-center gap-2 border p-4 text-sm">
          <Lock className="h-4 w-4" aria-hidden />
          Exporting requires manager or owner role. Ask the account owner to run an export.
        </p>
      ) : (
        <>
          {!isPlus ? (
            <p className="rounded-card border-hairline bg-cloud text-ash mt-6 flex items-center gap-2 border p-4 text-sm">
              <Lock className="h-4 w-4" aria-hidden />
              Bulk PII export is a Plus-tier feature. Per-guest rectification and erasure remain
              available on every plan from the guest&apos;s profile.
            </p>
          ) : null}
          <section className="mt-6 grid gap-4 md:grid-cols-2">
            <ExportCard
              title="Guests"
              entity="guests"
              count={counts.guests}
              description="One row per guest, excluding erased records. Includes decrypted email, phone, and last name."
              disabled={!canExportData}
            />
            <ExportCard
              title="Bookings"
              entity="bookings"
              count={counts.bookings}
              description="One row per booking with venue, service, area, guest first name and email, party size, status, and source."
              disabled={!canExportData}
            />
          </section>
        </>
      )}

      <section className="mt-10 flex flex-col gap-2">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Coming soon</h2>
        <p className="text-ash text-sm">
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
    <article className="rounded-card border-hairline flex flex-col gap-3 border bg-white p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-ink text-base font-semibold tracking-tight">{title}</h3>
        <span className="text-ash text-xs">
          {count.toLocaleString("en-GB")} {count === 1 ? "row" : "rows"}
        </span>
      </header>
      <p className="text-ash text-sm">{description}</p>
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
      <span className={`${base} text-mute cursor-not-allowed`} aria-disabled>
        <Download className="h-4 w-4" aria-hidden />
        {format.toUpperCase()}
      </span>
    );
  }
  return (
    <a
      href={`/dashboard/data/export/${entity}?format=${format}`}
      className={`${base} text-ink hover:border-ink bg-white`}
      // download attribute is informational — Content-Disposition on
      // the response sets the actual filename (with today's date).
      download
    >
      <Download className="h-4 w-4" aria-hidden />
      {format.toUpperCase()}
    </a>
  );
}
