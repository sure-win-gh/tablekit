"use client";

import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardBody, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import type { LeadTimeRow } from "@/lib/reports/insights/types";

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
