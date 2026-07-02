import { TrendChart } from "@/components/admin/charts";
import { Empty, HBar, KpiTile, Section, pctStr } from "@/components/admin/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { getBookingCounts } from "@/lib/server/admin/dashboard/metrics/bookings";
import { getFeatureAdoption } from "@/lib/server/admin/dashboard/metrics/feature-adoption";
import { getSignupCounts, getSignupsByDay } from "@/lib/server/admin/dashboard/metrics/signups";

export const dynamic = "force-dynamic";

export default async function AdminGrowthPage() {
  await requirePlatformAdmin();

  const db = adminDb();
  const [signups, signupsByDay90, adoption, bookings] = await Promise.all([
    getSignupCounts(db),
    getSignupsByDay(db, 90),
    getFeatureAdoption(db),
    getBookingCounts(db),
  ]);

  const sortedFeatures = [...adoption.features].sort(
    (a, b) => b.orgsWithFeature - a.orgsWithFeature,
  );
  const venueTotal = adoption.venueTypeMix.reduce((s, r) => s + r.count, 0);
  const venueMax = Math.max(...adoption.venueTypeMix.map((r) => r.count), 0);
  const sourceTotal = bookings.sourceMix7d.reduce((s, r) => s + r.count, 0);
  const sourceMax = bookings.sourceMix7d[0]?.count ?? 0;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">Growth</h1>
        <p className="text-ash text-sm">
          Who&apos;s signing up, what they actually use, and what kind of venues they run. Low
          adoption is either a marketing signal or a usability flag.
        </p>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <KpiTile label="Signups today" value={String(signups.today)} />
        <KpiTile label="Last 7 days" value={String(signups.last7d)} />
        <KpiTile label="Last 30 days" value={String(signups.last30d)} />
      </div>

      <Section
        title="Signups — last 90 days"
        description="Organisation creations per UTC day."
        csvHref="/admin/export/signups?days=90"
      >
        {signupsByDay90.every((d) => d.n === 0) ? (
          <Empty message="No signups in the last 90 days." />
        ) : (
          <TrendChart
            data={signupsByDay90}
            label="Signups"
            color="var(--color-coral)"
            height={200}
          />
        )}
      </Section>

      <Section
        title="Feature adoption"
        description={`% of ${adoption.totalOrgs} organisations using each feature.`}
        csvHref="/admin/export/adoption"
      >
        {adoption.totalOrgs === 0 ? (
          <Empty message="No organisations on the platform yet." />
        ) : (
          <div className="flex flex-col gap-2">
            {sortedFeatures.map((row) => (
              <HBar
                key={row.key}
                label={row.label}
                value={row.orgsWithFeature}
                max={adoption.totalOrgs}
                display={pctStr(row.orgsWithFeature / adoption.totalOrgs)}
                sub={`${row.orgsWithFeature} orgs`}
                color={
                  row.orgsWithFeature / adoption.totalOrgs >= 0.5
                    ? "var(--color-ink)"
                    : "var(--color-mute)"
                }
              />
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section title="Venue type mix" description="What kind of venues sign up.">
          {adoption.venueTypeMix.length === 0 ? (
            <Empty message="No venues yet." />
          ) : (
            <div className="flex flex-col gap-2">
              {[...adoption.venueTypeMix]
                .sort((a, b) => b.count - a.count)
                .map((row) => (
                  <HBar
                    key={row.venueType}
                    label={row.venueType.replace("_", " / ")}
                    value={row.count}
                    max={venueMax}
                    display={venueTotal === 0 ? "—" : pctStr(row.count / venueTotal)}
                    sub={`${row.count} venues`}
                    color="var(--color-coral)"
                  />
                ))}
            </div>
          )}
        </Section>

        <Section
          title="Booking source mix — last 7 days"
          description="Platform-wide channel split."
        >
          {bookings.sourceMix7d.length === 0 ? (
            <Empty message="No bookings in the last 7 days." />
          ) : (
            <div className="flex flex-col gap-2">
              {bookings.sourceMix7d.map((row) => (
                <HBar
                  key={row.source}
                  label={row.source}
                  value={row.count}
                  max={sourceMax}
                  display={sourceTotal === 0 ? "—" : pctStr(row.count / sourceTotal)}
                  sub={`${row.count} bookings`}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
