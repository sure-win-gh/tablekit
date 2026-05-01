"use client";

import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { Card, CardBody, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import { formatVenueDateLong } from "@/lib/bookings/time";
import type {
  CoversRow,
  DepositRevenueRow,
  NoShowSummary,
  SourceMixRow,
  TopGuestRow,
} from "@/lib/reports/types";

// ---------------------------------------------------------------------------
// Date range picker. Pure URL-driven — pushes ?from/?to onto the route.
// Native <input type=date> for the MVP; a richer picker can come later.
// ---------------------------------------------------------------------------
export function DateRangeNav({
  venueId,
  fromDate,
  toDate,
}: {
  venueId: string;
  fromDate: string;
  toDate: string;
}) {
  const router = useRouter();
  const setRange = (next: { from?: string; to?: string }) => {
    const f = next.from ?? fromDate;
    const t = next.to ?? toDate;
    router.push(`/dashboard/venues/${venueId}/reports?from=${f}&to=${t}`);
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="text-ash flex items-center gap-1.5">
        From
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => setRange({ from: e.target.value })}
          size="sm"
          className="w-auto"
        />
      </label>
      <label className="text-ash flex items-center gap-1.5">
        To
        <Input
          type="date"
          value={toDate}
          onChange={(e) => setRange({ to: e.target.value })}
          size="sm"
          className="w-auto"
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local helpers — report-card chrome + fmt utilities.
// ---------------------------------------------------------------------------
function ReportCard({
  title,
  description,
  downloadHref,
  children,
}: {
  title: string;
  description: string;
  downloadHref: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <a
          href={downloadHref}
          className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1 text-xs font-semibold transition"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          CSV
        </a>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

function Empty({ message }: { message: string }) {
  return <p className="text-ash text-xs">{message}</p>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border-hairline border bg-white px-3 py-2">
      <div className="text-ash text-xs">{label}</div>
      <div className="text-ink text-lg font-bold tracking-tight tabular-nums">{value}</div>
      {sub ? <div className="text-ash text-[11px] tabular-nums">{sub}</div> : null}
    </div>
  );
}

const TABLE = "w-full text-xs";
const THEAD = "text-left text-ash";
const TBODY = "divide-y divide-hairline";

// Format minor units → "£12.50". GBP-only for MVP — every UK
// operator is GBP. Multi-currency will need a venue.currency lookup.
function gbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const v = Math.abs(minor);
  return `${sign}£${(v / 100).toFixed(2)}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Covers — per-day-per-service table.
// ---------------------------------------------------------------------------
export function CoversCard({ rows, downloadHref }: { rows: CoversRow[]; downloadHref: string }) {
  return (
    <ReportCard
      title="Covers"
      description="Bookings + party size by day and service. Realised excludes cancellations and no-shows."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr>
              <th className="py-1">Day</th>
              <th>Service</th>
              <th className="text-right">Bookings</th>
              <th className="text-right">Covers booked</th>
              <th className="text-right">Covers realised</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {rows.map((r) => (
              <tr key={`${r.day}-${r.serviceId}`}>
                <td className="py-1 font-mono tabular-nums">{r.day}</td>
                <td>{r.serviceName}</td>
                <td className="text-right tabular-nums">{r.bookings}</td>
                <td className="text-right tabular-nums">{r.coversBooked}</td>
                <td className="text-right tabular-nums">{r.coversRealised}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// No-show summary.
// ---------------------------------------------------------------------------
export function NoShowCard({
  summary,
  downloadHref,
}: {
  summary: NoShowSummary;
  downloadHref: string;
}) {
  return (
    <ReportCard
      title="No-show rate"
      description="Of bookings the operator showed up to (confirmed/seated/finished/no-show), how many no-showed."
      downloadHref={downloadHref}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat
          label="Overall"
          value={pct(summary.rate)}
          sub={`${summary.totalNoShows} of ${summary.totalEligible}`}
        />
        <Stat
          label="With deposit"
          value={pct(summary.withDepositRate)}
          sub={`${summary.withDepositNoShows} of ${summary.withDepositEligible}`}
        />
        <Stat
          label="Without deposit"
          value={pct(deriveNoDepositRate(summary))}
          sub={`${summary.totalNoShows - summary.withDepositNoShows} of ${
            summary.totalEligible - summary.withDepositEligible
          }`}
        />
      </div>
      {summary.byService.length > 0 ? (
        <table className={`mt-4 ${TABLE}`}>
          <thead className={THEAD}>
            <tr>
              <th className="py-1">Service</th>
              <th className="text-right">Eligible</th>
              <th className="text-right">No-shows</th>
              <th className="text-right">Rate</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {summary.byService.map((s) => (
              <tr key={s.serviceId}>
                <td className="py-1">{s.serviceName}</td>
                <td className="text-right tabular-nums">{s.eligible}</td>
                <td className="text-right tabular-nums">{s.noShows}</td>
                <td className="text-right tabular-nums">{pct(s.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </ReportCard>
  );
}

// `summary.totalEligible` minus `summary.withDepositEligible` is the
// no-deposit cohort. If that's zero we get a 0% rate, which is more
// honest than NaN.
function deriveNoDepositRate(s: NoShowSummary): number {
  const eligible = s.totalEligible - s.withDepositEligible;
  const noShows = s.totalNoShows - s.withDepositNoShows;
  return eligible === 0 ? 0 : noShows / eligible;
}

// ---------------------------------------------------------------------------
// Deposit revenue / refunds.
// ---------------------------------------------------------------------------
export function DepositsCard({
  rows,
  downloadHref,
}: {
  rows: DepositRevenueRow[];
  downloadHref: string;
}) {
  const total = rows.reduce(
    (acc, r) => ({
      collected: acc.collected + r.depositsCollectedMinor,
      noShow: acc.noShow + r.noShowCapturedMinor,
      refunded: acc.refunded + r.refundedMinor,
      net: acc.net + r.netMinor,
    }),
    { collected: 0, noShow: 0, refunded: 0, net: 0 },
  );
  return (
    <ReportCard
      title="Deposit revenue"
      description="Bucketed by booking day. Net = deposits + no-show captures − refunds."
      downloadHref={downloadHref}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Deposits collected" value={gbp(total.collected)} />
        <Stat label="No-show captures" value={gbp(total.noShow)} />
        <Stat label="Refunded" value={gbp(total.refunded)} />
        <Stat label="Net" value={gbp(total.net)} />
      </div>
      {rows.length > 0 ? (
        <table className={`mt-4 ${TABLE}`}>
          <thead className={THEAD}>
            <tr>
              <th className="py-1">Day</th>
              <th className="text-right">Deposits</th>
              <th className="text-right">No-show</th>
              <th className="text-right">Refunded</th>
              <th className="text-right">Net</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {rows.map((r) => (
              <tr key={r.day}>
                <td className="py-1 font-mono tabular-nums">{r.day}</td>
                <td className="text-right tabular-nums">{gbp(r.depositsCollectedMinor)}</td>
                <td className="text-right tabular-nums">{gbp(r.noShowCapturedMinor)}</td>
                <td className="text-right tabular-nums">{gbp(r.refundedMinor)}</td>
                <td className="text-right tabular-nums">{gbp(r.netMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty message="No payment activity in this range." />
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Source mix.
// ---------------------------------------------------------------------------
export function SourcesCard({
  rows,
  downloadHref,
}: {
  rows: SourceMixRow[];
  downloadHref: string;
}) {
  const total = rows.reduce((acc, r) => acc + r.bookings, 0);
  return (
    <ReportCard
      title="Source mix"
      description="Where bookings came from. Cancellations included — top-of-funnel signal."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr>
              <th className="py-1">Source</th>
              <th className="text-right">Bookings</th>
              <th className="text-right">Covers</th>
              <th className="text-right">% of bookings</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {rows.map((r) => (
              <tr key={r.source}>
                <td className="py-1">{r.source}</td>
                <td className="text-right tabular-nums">{r.bookings}</td>
                <td className="text-right tabular-nums">{r.covers}</td>
                <td className="text-right tabular-nums">
                  {total === 0 ? "—" : pct(r.bookings / total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Top guests.
// ---------------------------------------------------------------------------
export function TopGuestsCard({
  rows,
  timezone,
  downloadHref,
}: {
  rows: TopGuestRow[];
  timezone: string;
  downloadHref: string;
}) {
  return (
    <ReportCard
      title="Top returning guests"
      description="Realised visits in the range, minimum two. First name only — open the guest record for the full profile."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No guests with two or more visits in this range." />
      ) : (
        <table className={TABLE}>
          <thead className={THEAD}>
            <tr>
              <th className="py-1">Guest</th>
              <th className="text-right">Visits</th>
              <th>Last visit</th>
            </tr>
          </thead>
          <tbody className={TBODY}>
            {rows.map((r) => (
              <tr key={r.guestId}>
                <td className="py-1">{r.firstName}</td>
                <td className="text-right tabular-nums">{r.visits}</td>
                <td>{formatVenueDateLong(r.lastVisit, { timezone })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}
