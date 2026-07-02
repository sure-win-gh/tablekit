"use client";

import { format, parseISO } from "date-fns";
import { ChevronDown, Download, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardBody, CardDescription, CardHeader, CardTitle, Input, cn } from "@/components/ui";
import { formatVenueDateLong } from "@/lib/bookings/time";
import type {
  CancellationsReport,
  CoversRow,
  DepositRevenueRow,
  NoShowSummary,
  OccupancyRow,
  PeakTimeCell,
  ReviewsReport,
  SourceMixRow,
  SpendReport,
  TopGuestRow,
} from "@/lib/reports/types";

// ---------------------------------------------------------------------------
// Date range picker — URL-driven, with quick presets relative to the
// current "to" date so the venue-local default stays authoritative.
// ---------------------------------------------------------------------------
const PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

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
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div
        className="border-hairline rounded-pill inline-flex overflow-hidden border bg-white"
        role="group"
        aria-label="Quick ranges"
      >
        {PRESETS.map((p) => {
          const active = fromDate === shiftYmd(toDate, -(p.days - 1));
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={active}
              onClick={() => setRange({ from: shiftYmd(toDate, -(p.days - 1)) })}
              className={cn(
                "px-3 py-1 font-semibold transition",
                active ? "bg-ink text-white" : "text-ash hover:text-ink",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
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
// KPI band — the range's headline numbers, readable from across the room.
// ---------------------------------------------------------------------------
export type KpiItem = {
  label: string;
  value: string;
  sub?: string;
  // Accent tints the value; used sparingly (coral = needs attention).
  accent?: "coral" | "none";
};

export function KpiBand({ items }: { items: KpiItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {items.map((k) => (
        <div
          key={k.label}
          className="rounded-card border-hairline shadow-panel border bg-white px-4 py-3"
        >
          <div className="text-ash text-[11px] font-semibold tracking-wide uppercase">
            {k.label}
          </div>
          <div
            className={cn(
              "mt-0.5 text-2xl font-bold tracking-tight tabular-nums",
              k.accent === "coral" ? "text-coral-deep" : "text-ink",
            )}
          >
            {k.value}
          </div>
          {k.sub ? <div className="text-ash text-[11px] tabular-nums">{k.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome + helpers.
// ---------------------------------------------------------------------------
function ReportCard({
  title,
  description,
  downloadHref,
  children,
}: {
  title: string;
  description: string;
  downloadHref?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {downloadHref ? (
          <a
            href={downloadHref}
            className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1 text-xs font-semibold transition"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        ) : null}
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

// Collapsible raw-data table so the numbers behind every chart stay one
// click away (and screen-reader friendly) without dominating the page.
function DataTable({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-ash hover:text-ink inline-flex items-center gap-1 text-xs font-semibold transition"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Hide data" : "View data"}
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

const TABLE = "w-full text-xs";
const THEAD = "text-left text-ash";
const TBODY = "divide-y divide-hairline";

// Chart palette — design tokens only (CLAUDE.md: don't hand-roll colours).
const C = {
  ink: "var(--color-ink)",
  coral: "var(--color-coral)",
  charcoal: "var(--color-charcoal)",
  ash: "var(--color-ash)",
  mute: "var(--color-mute)",
  stone: "var(--color-stone)",
  rose: "var(--color-rose)",
  cloud: "var(--color-cloud)",
} as const;

const PIE_PALETTE = [C.ink, C.coral, C.charcoal, C.mute, C.stone];

function pieColor(i: number): string {
  return PIE_PALETTE[i % PIE_PALETTE.length] ?? C.ink;
}

const AXIS_TICK = { fontSize: 11, fill: "var(--color-ash)" };
const TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid var(--color-hairline)",
  boxShadow: "var(--shadow-panel)",
} as const;

function gbp(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const v = Math.abs(minor);
  return `${sign}£${(v / 100).toFixed(2)}`;
}

function gbpAxis(minor: number): string {
  return `£${Math.round(minor / 100)}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function dayTick(ymd: string): string {
  return format(parseISO(ymd), "d MMM");
}

// Calendar-day arithmetic on YYYY-MM-DD labels (no timezone — these are
// venue-local labels, not instants).
function shiftYmd(ymd: string, days: number): string {
  const [y = "1970", m = "01", d = "01"] = ymd.split("-");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Continuous day axis for charts. Capped: past ~a year we let the axis
// be sparse rather than build a 4,000-element array.
function enumerateDays(fromDate: string, toDate: string): string[] | null {
  const out: string[] = [];
  let cur = fromDate;
  while (cur <= toDate) {
    out.push(cur);
    if (out.length > 366) return null;
    cur = shiftYmd(cur, 1);
  }
  return out;
}

function zeroFill<T extends { day: string }>(
  rows: T[],
  fromDate: string,
  toDate: string,
  empty: (day: string) => T,
): T[] {
  const days = enumerateDays(fromDate, toDate);
  if (!days) return rows;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => byDay.get(day) ?? empty(day));
}

// ---------------------------------------------------------------------------
// Covers — booked vs realised per day, services aggregated for the chart;
// the per-service split stays in the collapsible table.
// ---------------------------------------------------------------------------
export function CoversCard({
  rows,
  fromDate,
  toDate,
  downloadHref,
}: {
  rows: CoversRow[];
  fromDate: string;
  toDate: string;
  downloadHref: string;
}) {
  const daily = useMemo(() => {
    const acc = new Map<string, { day: string; booked: number; realised: number }>();
    for (const r of rows) {
      const cur = acc.get(r.day) ?? { day: r.day, booked: 0, realised: 0 };
      cur.booked += r.coversBooked;
      cur.realised += r.coversRealised;
      acc.set(r.day, cur);
    }
    return zeroFill(
      [...acc.values()].sort((a, b) => a.day.localeCompare(b.day)),
      fromDate,
      toDate,
      (day) => ({
        day,
        booked: 0,
        realised: 0,
      }),
    );
  }, [rows, fromDate, toDate]);

  return (
    <ReportCard
      title="Covers"
      description="Booked vs realised covers per day. Realised excludes cancellations and no-shows — the gap is seats you planned for but didn't fill."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={1}>
                <CartesianGrid strokeDasharray="2 2" vertical={false} />
                <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={24} />
                <YAxis allowDecimals={false} tick={AXIS_TICK} width={36} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: "var(--color-cloud)" }}
                  labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
                />
                <Bar dataKey="booked" name="Booked" fill={C.stone} radius={[3, 3, 0, 0]} />
                <Bar dataKey="realised" name="Realised" fill={C.coral} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ChartLegend
            items={[
              { label: "Booked", color: C.stone },
              { label: "Realised", color: C.coral },
            ]}
          />
          <DataTable>
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
          </DataTable>
        </>
      )}
    </ReportCard>
  );
}

function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4">
      {items.map((i) => (
        <span key={i.label} className="text-ash inline-flex items-center gap-1.5 text-[11px]">
          <span
            className="inline-block h-2.5 w-2.5 rounded-[3px]"
            style={{ backgroundColor: i.color }}
            aria-hidden
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// Horizontal comparison bar — used for services, reasons, sources.
function HBar({
  label,
  value,
  max,
  display,
  sub,
  color = C.ink,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  sub?: string;
  color?: string;
}) {
  const width = max === 0 ? 0 : Math.max(2, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-ink w-32 shrink-0 truncate" title={label}>
        {label}
      </span>
      <span className="bg-cloud relative h-4 flex-1 overflow-hidden rounded-[4px]">
        <span
          className="absolute inset-y-0 left-0 rounded-[4px]"
          style={{ width: `${width}%`, backgroundColor: color }}
          aria-hidden
        />
      </span>
      <span className="text-ink w-14 shrink-0 text-right font-semibold tabular-nums">
        {display}
      </span>
      {sub ? <span className="text-ash w-20 shrink-0 text-right tabular-nums">{sub}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// No-show — stat trio + per-service comparison bars.
// ---------------------------------------------------------------------------
export function NoShowCard({
  summary,
  downloadHref,
}: {
  summary: NoShowSummary;
  downloadHref: string;
}) {
  const maxRate = Math.max(...summary.byService.map((s) => s.rate), 0);
  return (
    <ReportCard
      title="No-show rate"
      description="Of bookings that reached the door (confirmed, seated, finished, or no-show), how many never turned up."
      downloadHref={downloadHref}
    >
      <div className="grid grid-cols-3 gap-3">
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
        <div className="mt-4 flex flex-col gap-2">
          {summary.byService.map((s) => (
            <HBar
              key={s.serviceId}
              label={s.serviceName}
              value={s.rate}
              max={maxRate}
              display={pct(s.rate)}
              sub={`${s.noShows} of ${s.eligible}`}
              color={C.coral}
            />
          ))}
        </div>
      ) : null}
    </ReportCard>
  );
}

function deriveNoDepositRate(s: NoShowSummary): number {
  const eligible = s.totalEligible - s.withDepositEligible;
  const noShows = s.totalNoShows - s.withDepositNoShows;
  return eligible === 0 ? 0 : noShows / eligible;
}

// ---------------------------------------------------------------------------
// Cancellations — trend bars + reason breakdown.
// ---------------------------------------------------------------------------
export function CancellationsCard({
  report,
  fromDate,
  toDate,
  downloadHref,
}: {
  report: CancellationsReport;
  fromDate: string;
  toDate: string;
  downloadHref: string;
}) {
  const daily = useMemo(
    () => zeroFill(report.byDay, fromDate, toDate, (day) => ({ day, bookings: 0, cancelled: 0 })),
    [report.byDay, fromDate, toDate],
  );
  const maxReason = Math.max(...report.byReason.map((r) => r.count), 0);
  return (
    <ReportCard
      title="Cancellations"
      description="Bookings for a slot in this range that were cancelled, and why. Watch for reason spikes — they're usually fixable."
      downloadHref={downloadHref}
    >
      {report.totalBookings === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Stat
              label="Cancellation rate"
              value={pct(report.rate)}
              sub={`${report.cancelled} of ${report.totalBookings} bookings`}
            />
            <Stat label="Cancelled" value={String(report.cancelled)} />
          </div>
          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 2" vertical={false} />
                <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={24} />
                <YAxis allowDecimals={false} tick={AXIS_TICK} width={30} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: "var(--color-cloud)" }}
                  labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
                />
                <Bar dataKey="cancelled" name="Cancelled" fill={C.rose} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {report.byReason.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {report.byReason.map((r) => (
                <HBar
                  key={r.reason}
                  label={humanise(r.reason)}
                  value={r.count}
                  max={maxReason}
                  display={String(r.count)}
                  color={C.charcoal}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </ReportCard>
  );
}

function humanise(s: string): string {
  const spaced = s.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------
// Deposits — stat band + stacked revenue bars with a net line.
// ---------------------------------------------------------------------------
export function DepositsCard({
  rows,
  fromDate,
  toDate,
  downloadHref,
}: {
  rows: DepositRevenueRow[];
  fromDate: string;
  toDate: string;
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
  // zeroFill doesn't mutate — rows pass through untouched.
  const daily = useMemo(
    () =>
      zeroFill(rows, fromDate, toDate, (day) => ({
        day,
        depositsCollectedMinor: 0,
        noShowCapturedMinor: 0,
        refundedMinor: 0,
        netMinor: 0,
      })),
    [rows, fromDate, toDate],
  );
  return (
    <ReportCard
      title="Deposit revenue"
      description="Bucketed by booking day. Net = deposits + no-show captures − refunds."
      downloadHref={downloadHref}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Deposits" value={gbp(total.collected)} />
        <Stat label="No-show captures" value={gbp(total.noShow)} />
        <Stat label="Refunded" value={gbp(total.refunded)} />
        <Stat label="Net" value={gbp(total.net)} />
      </div>
      {rows.length > 0 ? (
        <div className="mt-4 h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="2 2" vertical={false} />
              <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={24} />
              <YAxis tick={AXIS_TICK} tickFormatter={gbpAxis} width={44} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: "var(--color-cloud)" }}
                labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
                formatter={(value, name) => [gbp(Number(value)), String(name)]}
              />
              <Bar
                dataKey="depositsCollectedMinor"
                name="Deposits"
                stackId="rev"
                fill={C.ink}
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="noShowCapturedMinor"
                name="No-show captures"
                stackId="rev"
                fill={C.coral}
                radius={[3, 3, 0, 0]}
              />
              <Line
                dataKey="netMinor"
                name="Net"
                stroke={C.ash}
                strokeWidth={1.5}
                dot={false}
                type="monotone"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-ash mt-3 text-xs">No payment activity in this range.</p>
      )}
      {rows.length > 0 ? (
        <>
          <ChartLegend
            items={[
              { label: "Deposits", color: C.ink },
              { label: "No-show captures", color: C.coral },
              { label: "Net", color: C.ash },
            ]}
          />
          <DataTable>
            <table className={TABLE}>
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
          </DataTable>
        </>
      ) : null}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Source mix — donut + share bars.
// ---------------------------------------------------------------------------
export function SourcesCard({
  rows,
  downloadHref,
}: {
  rows: SourceMixRow[];
  downloadHref: string;
}) {
  const total = rows.reduce((acc, r) => acc + r.bookings, 0);
  const sorted = [...rows].sort((a, b) => b.bookings - a.bookings);
  return (
    <ReportCard
      title="Source mix"
      description="Where bookings came from. Cancellations included — this is a top-of-funnel signal."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No bookings in this range." />
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div className="h-40 w-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={sorted}
                  dataKey="bookings"
                  nameKey="source"
                  innerRadius="62%"
                  outerRadius="100%"
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {sorted.map((r, i) => (
                    <Cell key={r.source} fill={pieColor(i)} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value, name) => [
                    `${value} bookings (${total === 0 ? "—" : pct(Number(value) / total)})`,
                    humanise(String(name)),
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            {sorted.map((r, i) => (
              <HBar
                key={r.source}
                label={humanise(r.source)}
                value={r.bookings}
                max={sorted[0]?.bookings ?? 0}
                display={total === 0 ? "—" : pct(r.bookings / total)}
                sub={`${r.bookings} bkg · ${r.covers} cov`}
                color={pieColor(i)}
              />
            ))}
          </div>
        </div>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Peak times heatmap — venue-local weekday × hour, coloured by covers.
// ---------------------------------------------------------------------------
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function PeakTimesCard({
  cells,
  downloadHref,
}: {
  cells: PeakTimeCell[];
  downloadHref: string;
}) {
  const { hours, grid, maxCovers } = useMemo(() => {
    const byKey = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
    const active = cells.filter((c) => c.covers > 0);
    // Trim the axis to trading hours (±1h pad); default to 09–22 when empty.
    const minH = active.length ? Math.max(0, Math.min(...active.map((c) => c.hour)) - 1) : 9;
    const maxH = active.length ? Math.min(23, Math.max(...active.map((c) => c.hour)) + 1) : 22;
    const hourList: number[] = [];
    for (let h = minH; h <= maxH; h++) hourList.push(h);
    const max = Math.max(...cells.map((c) => c.covers), 0);
    const g = WEEKDAY_LABELS.map((_, i) =>
      hourList.map(
        (h) => byKey.get(`${i + 1}-${h}`) ?? { weekday: i + 1, hour: h, bookings: 0, covers: 0 },
      ),
    );
    return { hours: hourList, grid: g, maxCovers: max };
  }, [cells]);

  return (
    <ReportCard
      title="Peak times"
      description="Realised covers by day of week and hour, summed over the range. Darker = busier; the gaps are your quiet-hour opportunities."
      downloadHref={downloadHref}
    >
      {maxCovers === 0 ? (
        <Empty message="No realised bookings in this range." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[560px] gap-[3px]"
              style={{ gridTemplateColumns: `2.5rem repeat(${hours.length}, minmax(0, 1fr))` }}
              role="img"
              aria-label="Heatmap of covers by weekday and hour"
            >
              <span aria-hidden />
              {hours.map((h) => (
                <span key={h} className="text-ash text-center text-[10px] tabular-nums">
                  {String(h).padStart(2, "0")}
                </span>
              ))}
              {grid.map((row, i) => (
                <Fragment key={WEEKDAY_LABELS[i]}>
                  <span className="text-ash self-center text-[11px] font-semibold">
                    {WEEKDAY_LABELS[i]}
                  </span>
                  {row.map((cell) => {
                    const intensity = maxCovers === 0 ? 0 : cell.covers / maxCovers;
                    return (
                      <span
                        key={`${cell.weekday}-${cell.hour}`}
                        title={`${WEEKDAY_LABELS[i]} ${String(cell.hour).padStart(2, "0")}:00 — ${cell.covers} covers, ${cell.bookings} bookings`}
                        className="border-hairline/40 h-7 rounded-[4px] border"
                        style={{
                          backgroundColor:
                            cell.covers === 0
                              ? "var(--color-cloud)"
                              : `color-mix(in srgb, var(--color-coral) ${Math.round(
                                  12 + intensity * 88,
                                )}%, white)`,
                        }}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
          <div className="text-ash mt-2 flex items-center gap-2 text-[11px]">
            Quiet
            <span
              className="h-2.5 w-24 rounded-[3px]"
              style={{
                background: "linear-gradient(to right, var(--color-cloud), var(--color-coral))",
              }}
              aria-hidden
            />
            Busy · peak cell = {maxCovers} covers
          </div>
        </>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Occupancy — utilisation per service vs seats on sale.
// ---------------------------------------------------------------------------
export function OccupancyCard({
  rows,
  downloadHref,
}: {
  rows: OccupancyRow[];
  downloadHref: string;
}) {
  return (
    <ReportCard
      title="Occupancy"
      description="Realised covers vs the seats each service had on sale across the range. Low bars are sessions you could promote or trim."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No services configured for this venue." />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.serviceId}>
              <HBar
                label={r.serviceName}
                value={Math.min(r.utilisation, 1)}
                max={1}
                display={pct(r.utilisation)}
                sub={`${r.coversRealised} / ${r.totalCapacity}`}
                color={r.utilisation >= 0.8 ? C.coral : C.ink}
              />
              <div className="text-ash mt-0.5 pl-35 text-[10px]">
                {r.sessionsInRange} sessions × {r.capacityPerSession} seats
              </div>
            </div>
          ))}
        </div>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Reviews — rating trend + source / sentiment mix.
// ---------------------------------------------------------------------------
export function ReviewsCard({
  report,
  downloadHref,
}: {
  report: ReviewsReport;
  downloadHref: string;
}) {
  const sentimentTotal =
    report.sentiment.positive + report.sentiment.neutral + report.sentiment.negative;
  return (
    <ReportCard
      title="Reviews"
      description="Ratings submitted in this range, across every connected platform."
      downloadHref={downloadHref}
    >
      {report.count === 0 ? (
        <Empty message="No reviews in this range." />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-4">
            <div className="flex items-baseline gap-1.5">
              <Star className="text-coral h-5 w-5 self-center fill-current" aria-hidden />
              <span className="text-ink text-2xl font-bold tabular-nums">
                {report.avgRating?.toFixed(2) ?? "—"}
              </span>
              <span className="text-ash text-xs">avg of {report.count}</span>
            </div>
            {sentimentTotal > 0 ? (
              <div className="text-ash flex items-center gap-3 text-[11px]">
                <span className="text-emerald-600">{report.sentiment.positive} positive</span>
                <span>{report.sentiment.neutral} neutral</span>
                <span className="text-rose">{report.sentiment.negative} negative</span>
              </div>
            ) : null}
          </div>
          {report.byDay.length > 1 ? (
            <div className="h-36 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={report.byDay} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="2 2" vertical={false} />
                  <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={24} />
                  <YAxis domain={[1, 5]} tick={AXIS_TICK} width={24} allowDecimals={false} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
                    formatter={(value, name) =>
                      name === "avgRating"
                        ? [Number(value).toFixed(2), "Avg rating"]
                        : [String(value), "Reviews"]
                    }
                  />
                  <Line
                    dataKey="avgRating"
                    stroke={C.coral}
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: C.coral, strokeWidth: 0 }}
                    type="monotone"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {report.bySource.map((s) => (
              <span
                key={s.source}
                className="rounded-pill border-hairline text-ash border bg-white px-2.5 py-1 text-[11px]"
              >
                {humanise(s.source)}: <strong className="text-ink">{s.count}</strong> · ★{" "}
                {s.avgRating.toFixed(1)}
              </span>
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Spend — POS revenue for the range (only when a till is connected).
// ---------------------------------------------------------------------------
export function SpendCard({
  report,
  fromDate,
  toDate,
  downloadHref,
}: {
  report: SpendReport;
  fromDate: string;
  toDate: string;
  downloadHref: string;
}) {
  const daily = useMemo(
    () => zeroFill(report.byDay, fromDate, toDate, (day) => ({ day, orders: 0, revenueMinor: 0 })),
    [report.byDay, fromDate, toDate],
  );
  return (
    <ReportCard
      title="Spend (POS)"
      description="Till revenue for orders closed in this range. Spend per cover only counts orders where the till reported covers."
      downloadHref={downloadHref}
    >
      {report.orders === 0 ? (
        <Empty message="No POS orders in this range — connect a till under Settings → POS to see spend." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Revenue" value={gbp(report.revenueMinor)} />
            <Stat label="Orders" value={String(report.orders)} />
            <Stat label="Avg / order" value={gbp(report.avgPerOrderMinor)} />
            <Stat
              label="Avg / cover"
              value={report.avgPerCoverMinor === null ? "—" : gbp(report.avgPerCoverMinor)}
            />
          </div>
          <div className="mt-4 h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 2" vertical={false} />
                <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={24} />
                <YAxis tick={AXIS_TICK} tickFormatter={gbpAxis} width={44} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: "var(--color-cloud)" }}
                  labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
                  formatter={(value, name) =>
                    // `name` is the Bar's display name, not the dataKey.
                    name === "Revenue" ? [gbp(Number(value)), "Revenue"] : [String(value), name]
                  }
                />
                <Bar dataKey="revenueMinor" name="Revenue" fill={C.ink} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </ReportCard>
  );
}

// ---------------------------------------------------------------------------
// Top guests — visits as comparison bars, first names only.
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
  const maxVisits = Math.max(...rows.map((r) => r.visits), 0);
  return (
    <ReportCard
      title="Top returning guests"
      description="Realised visits in the range, minimum two. First name only — open the guest record for the full profile."
      downloadHref={downloadHref}
    >
      {rows.length === 0 ? (
        <Empty message="No guests with two or more visits in this range." />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <HBar
              key={r.guestId}
              label={r.firstName}
              value={r.visits}
              max={maxVisits}
              display={`×${r.visits}`}
              sub={formatVenueDateLong(r.lastVisit, { timezone })}
              color={C.ink}
            />
          ))}
        </div>
      )}
    </ReportCard>
  );
}
