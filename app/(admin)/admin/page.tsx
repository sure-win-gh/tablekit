import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import { platformAudit } from "@/lib/server/admin/dashboard/audit";
import { getBookingCounts } from "@/lib/server/admin/dashboard/metrics/bookings";
import { getMessageVolume7d } from "@/lib/server/admin/dashboard/metrics/messages";
import { getSignupCounts } from "@/lib/server/admin/dashboard/metrics/signups";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const session = await requirePlatformAdmin();
  await platformAudit.log({ actorEmail: session.email, action: "login" });

  const db = adminDb();
  const [signups, bookings, messages] = await Promise.all([
    getSignupCounts(db),
    getBookingCounts(db),
    getMessageVolume7d(db),
  ]);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Overview</h1>
        <p className="text-sm text-ash">
          Cross-organisation signal. UTC day buckets. Live counts; financials land in PR3.
        </p>
      </header>

      <Section title="Signups">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Today" value={signups.today.toString()} />
          <Stat label="Last 7 days" value={signups.last7d.toString()} />
          <Stat label="Last 30 days" value={signups.last30d.toString()} />
        </div>
      </Section>

      <Section title="Bookings">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Today" value={bookings.today.toString()} />
          <Stat label="Last 7 days" value={bookings.last7d.toString()} />
          <Stat label="Last 30 days" value={bookings.last30d.toString()} />
        </div>
        {bookings.sourceMix7d.length === 0 ? (
          <Empty message="No bookings in the last 7 days." />
        ) : (
          <table className="mt-4 w-full text-xs">
            <thead className="text-left text-ash">
              <tr>
                <th className="py-1 font-medium">Source</th>
                <th className="py-1 text-right font-medium">Bookings (7d)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {bookings.sourceMix7d.map((row) => (
                <tr key={row.source}>
                  <td className="py-1.5 text-ink">{row.source}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Transactional messages — last 7 days">
        {messages.length === 0 ? (
          <Empty message="No messages dispatched in the last 7 days." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-ash">
              <tr>
                <th className="py-1 font-medium">Channel</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {messages.map((row) => (
                <tr key={`${row.channel}-${row.status}`}>
                  <td className="py-1.5 text-ink">{row.channel}</td>
                  <td className="py-1.5 text-ink">{row.status}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card padding="lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-hairline bg-white px-3 py-2">
      <div className="text-xs text-ash">{label}</div>
      <div className="text-2xl font-bold tabular-nums tracking-tight text-ink">{value}</div>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <p className="text-xs text-ash">{message}</p>;
}
