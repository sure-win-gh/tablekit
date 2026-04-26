"use client";

import { useRouter } from "next/navigation";

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
      <label className="flex items-center gap-1 text-neutral-600">
        From
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setRange({ from: e.target.value })}
          className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
        />
      </label>
      <label className="flex items-center gap-1 text-neutral-600">
        To
        <input
          type="date"
          value={toDate}
          onChange={(e) => setRange({ to: e.target.value })}
          className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card chrome.
// ---------------------------------------------------------------------------
function Card({
  title,
  description,
  downloadHref,
  children,
}: {
  title: string;
  description: string;
  downloadHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
          <p className="text-xs text-neutral-500">{description}</p>
        </div>
        <a
          href={downloadHref}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900"
        >
          Download CSV
        </a>
      </header>
      <div className="px-4 py-3 text-sm text-neutral-900">{children}</div>
    </div>
  );
}

// Empty-state row. Identical pattern across cards.
function Empty({ message }: { message: string }) {
  return <p className="text-xs text-neutral-500">{message}</p>;
}

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
    <Card
      title="Covers"
      description="Bookings + party size by day and service. Realised excludes cancellations and no-shows."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1">Day</th>
              <th>Service</th>
              <th className="text-right">Bookings</th>
              <th className="text-right">Covers booked</th>
              <th className="text-right">Covers realised</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
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
    </Card>
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
    <Card
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
        <table className="mt-4 w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1">Service</th>
              <th className="text-right">Eligible</th>
              <th className="text-right">No-shows</th>
              <th className="text-right">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
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
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md border border-neutral-200 px-3 py-2">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-lg font-semibold text-neutral-900 tabular-nums">{value}</div>
      <div className="text-[11px] text-neutral-500 tabular-nums">{sub}</div>
    </div>
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
    <Card
      title="Deposit revenue"
      description="Bucketed by booking day. Net = deposits + no-show captures − refunds."
      downloadHref={downloadHref}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Deposits collected" value={gbp(total.collected)} sub="" />
        <Stat label="No-show captures" value={gbp(total.noShow)} sub="" />
        <Stat label="Refunded" value={gbp(total.refunded)} sub="" />
        <Stat label="Net" value={gbp(total.net)} sub="" />
      </div>
      {rows.length > 0 ? (
        <table className="mt-4 w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1">Day</th>
              <th className="text-right">Deposits</th>
              <th className="text-right">No-show</th>
              <th className="text-right">Refunded</th>
              <th className="text-right">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
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
    </Card>
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
    <Card
      title="Source mix"
      description="Where bookings came from. Cancellations included — top-of-funnel signal."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1">Source</th>
              <th className="text-right">Bookings</th>
              <th className="text-right">Covers</th>
              <th className="text-right">% of bookings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
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
    </Card>
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
    <Card
      title="Top returning guests"
      description="Realised visits in the range, minimum two. First name only — open the guest record for the full profile."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No guests with two or more visits in this range." />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1">Guest</th>
              <th className="text-right">Visits</th>
              <th>Last visit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
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
    </Card>
  );
}
