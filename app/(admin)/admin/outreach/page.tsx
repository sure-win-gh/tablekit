import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { Card, CardBody, CardHeader, CardTitle, Input } from "@/components/ui";
import { isConfigured, searchPlaces } from "@/lib/google/places";
import { organisations, outreachClaims } from "@/lib/db/schema";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";

import { CreateClaimForm } from "./create-form";

export const dynamic = "force-dynamic";

export default async function AdminOutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePlatformAdmin();
  const { q = "" } = await searchParams;

  // Min 3 chars: avoids burning Places quota and spamming the audit
  // log on refresh / single-letter typeahead.
  const trimmed = q.trim();
  const placesReady = isConfigured();
  const search = placesReady && trimmed.length >= 3 ? await searchPlaces(trimmed) : null;

  if (search) {
    await platformAudit.log({
      actorEmail: session.email,
      action: "searched",
      metadata: { surface: "outreach", query: trimmed.slice(0, 200) },
    });
  }

  const claims = await loadRecentClaims();

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Outreach</h1>
        <p className="text-ash text-sm">
          Build a pre-populated account for a prospect from their Google Places listing. They claim
          ownership via a magic link; unclaimed accounts auto-purge after 30 days.
        </p>
      </header>

      {!placesReady ? (
        <Card padding="lg">
          <CardBody>
            <p className="text-rose text-sm">
              <code>GOOGLE_PLACES_API_KEY</code> is not set. Add it to <code>.env.local</code> and
              restart the dev server to enable venue lookup.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <form action="/admin/outreach" method="get" className="flex items-center gap-2">
        <Input
          type="search"
          name="q"
          placeholder="Search by venue name (min 3 chars)"
          defaultValue={q}
          className="max-w-md"
          disabled={!placesReady}
        />
        <button
          type="submit"
          disabled={!placesReady}
          className="rounded-pill bg-ink inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Search
        </button>
        {q ? (
          <Link href="/admin/outreach" className="text-ash text-xs underline-offset-2 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      {search && !search.ok ? (
        <Card padding="lg">
          <CardBody>
            <p className="text-rose text-sm">
              Places API search failed: {search.error ?? `status ${search.status}`}
            </p>
          </CardBody>
        </Card>
      ) : null}

      {search && search.ok ? (
        <Card padding="lg">
          <CardHeader>
            <CardTitle>
              {search.places.length}{" "}
              {search.places.length === 1 ? "result" : "results"} matching “{q}”
            </CardTitle>
          </CardHeader>
          <CardBody>
            {search.places.length === 0 ? (
              <p className="text-ash text-xs">No matches. Try a more specific query.</p>
            ) : (
              <ul className="divide-hairline flex flex-col divide-y">
                {search.places.map((p) => (
                  <li key={p.id} className="flex flex-col gap-2 py-3">
                    <div>
                      <p className="text-ink text-sm font-semibold">{p.displayName}</p>
                      <p className="text-ash text-xs">{p.formattedAddress}</p>
                    </div>
                    <CreateClaimForm placeId={p.id} placeName={p.displayName} />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Recent claimable accounts</CardTitle>
        </CardHeader>
        <CardBody>
          {claims.length === 0 ? (
            <p className="text-ash text-xs">None yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-ash text-left">
                <tr>
                  <th className="py-1 font-medium">Organisation</th>
                  <th className="py-1 font-medium">Prospect</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {claims.map((c) => (
                  <tr key={c.organisationId}>
                    <td className="text-ink py-1.5">{c.organisationName}</td>
                    <td className="text-ink py-1.5">{c.prospectEmail}</td>
                    <td className="text-ink py-1.5">{statusLabel(c)}</td>
                    <td className="text-ash py-1.5 tabular-nums">
                      {c.createdAt.toLocaleDateString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

type ClaimRow = {
  organisationId: string;
  organisationName: string;
  prospectEmail: string;
  createdAt: Date;
  claimedAt: Date | null;
  expiresAt: Date;
};

async function loadRecentClaims(): Promise<ClaimRow[]> {
  const db = adminDb();
  const rows = await db
    .select({
      organisationId: outreachClaims.organisationId,
      organisationName: organisations.name,
      prospectEmail: outreachClaims.prospectEmail,
      createdAt: outreachClaims.createdAt,
      claimedAt: outreachClaims.claimedAt,
      expiresAt: outreachClaims.expiresAt,
    })
    .from(outreachClaims)
    .innerJoin(organisations, eq(organisations.id, outreachClaims.organisationId))
    .orderBy(desc(outreachClaims.createdAt))
    .limit(50);
  return rows;
}

function statusLabel(c: ClaimRow): string {
  if (c.claimedAt) return "Claimed";
  if (c.expiresAt < new Date()) return "Expired";
  const daysLeft = Math.ceil((c.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return `Pending — ${daysLeft}d left`;
}
