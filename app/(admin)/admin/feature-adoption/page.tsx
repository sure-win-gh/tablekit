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
        <h1 className="text-ink text-2xl font-bold tracking-tight">Feature adoption</h1>
        <p className="text-ash text-sm">
          % of {data.totalOrgs} organisations using each feature. A low rate is either a marketing
          signal or a usability flag.
        </p>
      </header>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>Feature usage</CardTitle>
        </CardHeader>
        <CardBody>
          {data.totalOrgs === 0 ? (
            <p className="text-ash text-xs">No organisations on the platform yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-ash text-left">
                <tr>
                  <th className="py-1 font-medium">Feature</th>
                  <th className="py-1 text-right font-medium">Orgs</th>
                  <th className="py-1 text-right font-medium">% of total</th>
                  <th className="py-1 font-medium">Bar</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {data.features.map((row) => {
                  const pct = (row.orgsWithFeature / data.totalOrgs) * 100;
                  return (
                    <tr key={row.key}>
                      <td className="text-ink py-1.5">{row.label}</td>
                      <td className="text-ink py-1.5 text-right tabular-nums">
                        {row.orgsWithFeature}
                      </td>
                      <td className="text-ink py-1.5 text-right tabular-nums">{pct.toFixed(1)}%</td>
                      <td className="py-1.5">
                        <div className="bg-cloud h-1.5 w-full max-w-[200px] rounded-full">
                          <div
                            className="bg-ink h-full rounded-full"
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
            <p className="text-ash text-xs">No venues yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-ash text-left">
                <tr>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 text-right font-medium">Venues</th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {data.venueTypeMix.map((row) => (
                  <tr key={row.venueType}>
                    <td className="text-ink py-1.5">{row.venueType}</td>
                    <td className="text-ink py-1.5 text-right tabular-nums">{row.count}</td>
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
