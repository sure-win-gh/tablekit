import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { getFeatureAdoption } from "@/lib/server/admin/dashboard/metrics/feature-adoption";

export const dynamic = "force-dynamic";

export default async function AdminFeatureAdoptionPage() {
  await requirePlatformAdmin();
  const data = await getFeatureAdoption(adminDb());

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Feature adoption</h1>
        <p className="text-sm text-ash">
          % of {data.totalOrgs} organisations using each feature. A low rate is either a
          marketing signal or a usability flag.
        </p>
      </header>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Feature usage</CardTitle>
        </CardHeader>
        <CardBody>
          {data.totalOrgs === 0 ? (
            <p className="text-xs text-ash">No organisations on the platform yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-ash">
                <tr>
                  <th className="py-1 font-medium">Feature</th>
                  <th className="py-1 text-right font-medium">Orgs</th>
                  <th className="py-1 text-right font-medium">% of total</th>
                  <th className="py-1 font-medium">Bar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.features.map((row) => {
                  const pct = (row.orgsWithFeature / data.totalOrgs) * 100;
                  return (
                    <tr key={row.key}>
                      <td className="py-1.5 text-ink">{row.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {row.orgsWithFeature}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-ink">
                        {pct.toFixed(1)}%
                      </td>
                      <td className="py-1.5">
                        <div className="h-1.5 w-full max-w-[200px] rounded-full bg-cloud">
                          <div
                            className="h-full rounded-full bg-ink"
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Venue type mix</CardTitle>
        </CardHeader>
        <CardBody>
          {data.venueTypeMix.length === 0 ? (
            <p className="text-xs text-ash">No venues yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-ash">
                <tr>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 text-right font-medium">Venues</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.venueTypeMix.map((row) => (
                  <tr key={row.venueType}>
                    <td className="py-1.5 text-ink">{row.venueType}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{row.count}</td>
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
