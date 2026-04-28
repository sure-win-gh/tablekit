import { Download } from "lucide-react";
import Link from "next/link";

import { Card, CardBody, CardHeader, CardTitle, Input } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { searchVenues } from "@/lib/server/admin/dashboard/metrics/venues-search";

export const dynamic = "force-dynamic";

export default async function AdminVenuesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePlatformAdmin();
  const { q = "" } = await searchParams;

  const db = adminDb();
  const rows = await searchVenues(db, q);

  // Log the search action — captures the actor + the query string in
  // metadata. Org targeting is set by the drill-down page, not here.
  if (q.trim().length > 0) {
    await platformAudit.log({
      actorEmail: session.email,
      action: "searched",
      metadata: { query: q.slice(0, 200) },
    });
  }

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Venues</h1>
        <p className="text-sm text-ash">
          Cross-organisation list with 14-day activity score. Search by org name, slug, or
          venue name. Click an org to drill down.
        </p>
      </header>

      <form action="/admin/venues" method="get" className="flex items-center gap-2">
        <Input
          type="search"
          name="q"
          placeholder="Search organisations or venues…"
          defaultValue={q}
          className="max-w-sm"
        />
        <button
          type="submit"
          className="inline-flex items-center rounded-pill bg-ink px-3 py-1.5 text-xs font-semibold text-white"
        >
          Search
        </button>
        {q ? (
          <Link
            href="/admin/venues"
            className="text-xs text-ash underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>
            {rows.length} {rows.length === 1 ? "organisation" : "organisations"}
            {q ? <span className="text-ash"> matching “{q}”</span> : null}
          </CardTitle>
          <a
            href={`/admin/export/venues${q ? `?q=${encodeURIComponent(q)}` : ""}`}
            className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-white px-3 py-1 text-xs font-semibold text-ink transition hover:border-ink"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        </CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <p className="text-xs text-ash">No matching organisations.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-ash">
                  <tr>
                    <th className="py-1 font-medium">Organisation</th>
                    <th className="py-1 font-medium">Plan</th>
                    <th className="py-1 text-right font-medium">Venues</th>
                    <th className="py-1 font-medium">Owner</th>
                    <th className="py-1 font-medium">Last booking</th>
                    <th className="py-1 font-medium">Last login</th>
                    <th className="py-1 text-right font-medium">Activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((row) => (
                    <tr key={row.orgId}>
                      <td className="py-1.5">
                        <Link
                          href={`/admin/venues/${row.orgId}`}
                          className="font-medium text-ink underline-offset-2 hover:underline"
                        >
                          {row.orgName}
                        </Link>
                        <div className="text-[11px] text-ash">{row.slug}</div>
                      </td>
                      <td className="py-1.5 text-ink">{row.plan}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {row.venueCount}
                      </td>
                      <td className="py-1.5 text-ash">{row.ownerEmail ?? "—"}</td>
                      <td className="py-1.5 tabular-nums text-ash">
                        {fmtDate(row.lastBookingAt)}
                      </td>
                      <td className="py-1.5 tabular-nums text-ash">
                        {fmtDate(row.lastLoginAt)}
                      </td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${
                          row.activityScore < 30 ? "text-rose" : "text-ink"
                        }`}
                      >
                        {row.activityScore}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}
