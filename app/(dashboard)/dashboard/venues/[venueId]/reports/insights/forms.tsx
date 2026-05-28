"use client";

import { parseISO, startOfWeek } from "date-fns";
import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardBody, CardDescription, CardHeader, CardTitle, Input, cn } from "@/components/ui";
import {
  GRANULARITIES,
  type ChannelPerformanceRow,
  type Granularity,
  type LeadTimeRow,
  type NoShowTrendDailyRow,
} from "@/lib/reports/insights/types";

// ---------------------------------------------------------------------------
// Date range picker — pushes ?from/?to onto the insights route. Mirrors
// the MVP reports DateRangeNav exactly so the two surfaces feel like
// siblings; kept here (rather than imported) so the insights route stays
// independent and tree-shakeable.
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
    router.push(`/dashboard/venues/${venueId}/reports/insights?from=${f}&to=${t}`);
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
// Card chrome — same shape as the MVP reports forms.tsx.
// ---------------------------------------------------------------------------
function InsightCard({
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

// ---------------------------------------------------------------------------
// Lead-time histogram. Single bar series; zero-filled buckets keep the
// X axis stable across date ranges.
// ---------------------------------------------------------------------------
export function LeadTimeCard({
  rows,
  downloadHref,
}: {
  rows: LeadTimeRow[];
  downloadHref: string;
}) {
  const totalBookings = rows.reduce((sum, r) => sum + r.bookings, 0);
  return (
    <InsightCard
      title="Lead time"
      description="How far in advance diners book. Cancellations excluded."
      downloadHref={downloadHref}
    >
      {totalBookings === 0 ? (
        <p className="text-ash text-xs">No bookings in this range.</p>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="2 2" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: "var(--color-stone-100, #f5f5f4)" }}
                formatter={(value) => [String(value), "Bookings"]}
              />
              <Bar dataKey="bookings" fill="var(--color-ink)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </InsightCard>
  );
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// No-show + cancellation evolution. The query returns daily rows; we roll
// them up to the picked granularity in the browser so toggling never hits
// the server.
// ---------------------------------------------------------------------------
const GRANULARITY_LABEL: Record<Granularity, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

function periodKey(day: string, granularity: Granularity): string {
  switch (granularity) {
    case "day":
      return day;
    case "week":
      // ISO week, Monday start — formatted as the week's Monday date.
      return startOfWeek(parseISO(day), { weekStartsOn: 1 }).toISOString().slice(0, 10);
    case "month":
      return day.slice(0, 7); // YYYY-MM
    case "year":
      return day.slice(0, 4); // YYYY
  }
}

type TrendPoint = {
  period: string;
  overallRate: number;
  withDepositRate: number | null;
};

function rollUp(rows: NoShowTrendDailyRow[], granularity: Granularity): TrendPoint[] {
  const acc = new Map<
    string,
    { eligible: number; noShows: number; wdEligible: number; wdNoShows: number }
  >();
  for (const r of rows) {
    const key = periodKey(r.day, granularity);
    const cur = acc.get(key) ?? { eligible: 0, noShows: 0, wdEligible: 0, wdNoShows: 0 };
    cur.eligible += r.eligible;
    cur.noShows += r.noShows;
    cur.wdEligible += r.withDepositEligible;
    cur.wdNoShows += r.withDepositNoShows;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, v]) => ({
      period,
      overallRate: v.eligible === 0 ? 0 : v.noShows / v.eligible,
      // Null when the period had no deposit-bound bookings, so the line
      // breaks rather than implying a real 0% with-deposit no-show rate.
      withDepositRate: v.wdEligible === 0 ? null : v.wdNoShows / v.wdEligible,
    }));
}

export function NoShowTrendCard({
  rows,
  downloadHref,
}: {
  rows: NoShowTrendDailyRow[];
  downloadHref: string;
}) {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const points = useMemo(() => rollUp(rows, granularity), [rows, granularity]);
  const totalEligible = rows.reduce((sum, r) => sum + r.eligible, 0);

  return (
    <InsightCard
      title="No-show evolution"
      description="No-show rate over time, with the deposit-backed cohort overlaid. Roll up by day, week, month, or year."
      downloadHref={downloadHref}
    >
      <div className="mb-3">
        <div
          className="border-hairline inline-flex overflow-hidden rounded-pill border bg-white text-xs"
          role="tablist"
          aria-label="Roll-up granularity"
        >
          {GRANULARITIES.map((g) => {
            const active = g === granularity;
            return (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setGranularity(g)}
                className={cn(
                  "px-3 py-1 font-semibold transition",
                  active ? "bg-ink text-white" : "text-ash hover:text-ink",
                )}
              >
                {GRANULARITY_LABEL[g]}
              </button>
            );
          })}
        </div>
      </div>
      {totalEligible === 0 ? (
        <p className="text-ash text-xs">No eligible bookings in this range.</p>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="2 2" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => pct(v)} width={44} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value) => (value == null ? "—" : pct(Number(value)))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                name="Overall"
                dataKey="overallRate"
                stroke="var(--color-ink)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                name="With deposit"
                dataKey="withDepositRate"
                stroke="var(--color-rose, #e11d48)"
                strokeWidth={2}
                strokeDasharray="4 2"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </InsightCard>
  );
}

// ---------------------------------------------------------------------------
// Channel performance — one row per known source, including explicit zero
// rows. The deposit-capture column is hidden when no channel had a
// deposit-bound booking in range (every depositCaptureRate is null).
// ---------------------------------------------------------------------------
export function ChannelPerformanceCard({
  rows,
  downloadHref,
}: {
  rows: ChannelPerformanceRow[];
  downloadHref: string;
}) {
  const showDeposit = rows.some((r) => r.depositCaptureRate !== null);
  return (
    <InsightCard
      title="Channel performance"
      description="How each booking channel performs. Zero rows shown so missing channels are visible."
      downloadHref={downloadHref}
    >
      <table className="w-full text-xs">
        <thead className="text-ash text-left">
          <tr>
            <th className="py-1">Channel</th>
            <th className="text-right">Bookings</th>
            <th className="text-right">No-show</th>
            <th className="text-right">Cancelled</th>
            <th className="text-right">Avg party</th>
            <th className="text-right">Avg lead (d)</th>
            {showDeposit ? <th className="text-right">Deposit capture</th> : null}
          </tr>
        </thead>
        <tbody className="divide-hairline divide-y">
          {rows.map((r) => (
            <tr key={r.source}>
              <td className="py-1">{r.source}</td>
              <td className="text-right tabular-nums">{r.bookings}</td>
              <td className="text-right tabular-nums">{pct(r.noShowRate)}</td>
              <td className="text-right tabular-nums">{pct(r.cancellationRate)}</td>
              <td className="text-right tabular-nums">{r.avgPartySize.toFixed(1)}</td>
              <td className="text-right tabular-nums">{r.avgLeadTimeDays.toFixed(1)}</td>
              {showDeposit ? (
                <td className="text-right tabular-nums">
                  {r.depositCaptureRate == null ? "—" : pct(r.depositCaptureRate)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </InsightCard>
  );
}
