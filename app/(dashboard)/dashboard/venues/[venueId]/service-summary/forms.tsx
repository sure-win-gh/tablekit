"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, IconButton, Input, cn } from "@/components/ui";
import { heatBucket, monthGridDays, weekDays, type HeatBucket } from "@/lib/services/calendar";
import type { DayUtilisation } from "@/lib/services/heatmap";

// Day navigator — prev / today / next + native date input. Mirrors the
// timeline's TimelineDateNav; `today` is the venue-local today (computed
// server-side) so the Today button lands on the operator's calendar day.
export function ServiceSummaryDateNav({
  venueId,
  date,
  today,
}: {
  venueId: string;
  date: string;
  today: string;
}) {
  const router = useRouter();
  const setDate = (d: string) =>
    router.push(`/dashboard/venues/${venueId}/service-summary?date=${d}`);
  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };
  return (
    <div className="flex items-center gap-1.5">
      <IconButton aria-label="Previous day" size="sm" onClick={() => shift(-1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
      <Button variant="secondary" size="sm" onClick={() => setDate(today)} disabled={date === today}>
        Today
      </Button>
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        size="sm"
        className="w-auto"
      />
      <IconButton aria-label="Next day" size="sm" onClick={() => shift(1)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar heatmap. The month's daily utilisation is fetched server-side and
// passed in; the month/week toggle is local state so it never re-queries.
// Cells deep-link to ?date= so clicking one re-renders the day panel below.
// ---------------------------------------------------------------------------

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const HEAT_CLASS: Record<HeatBucket, string> = {
  empty: "bg-cloud text-ash",
  low: "bg-emerald-100 text-emerald-900",
  mid: "bg-amber-100 text-amber-900",
  high: "bg-rose-200 text-rose-900",
};

export function HeatmapCalendar({
  venueId,
  selectedDate,
  monthFirst,
  days,
}: {
  venueId: string;
  selectedDate: string;
  monthFirst: string;
  days: DayUtilisation[];
}) {
  const [view, setView] = useState<"month" | "week">("month");
  const byDay = new Map(days.map((d) => [d.day, d]));
  const weeks = view === "month" ? monthGridDays(monthFirst) : [weekDays(selectedDate)];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-ash text-xs font-semibold uppercase tracking-wide">Utilisation</span>
        <div
          className="border-hairline inline-flex overflow-hidden rounded-pill border bg-white text-xs"
          role="tablist"
          aria-label="Calendar view"
        >
          {(["month", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                "px-3 py-1 font-semibold capitalize transition",
                view === v ? "bg-ink text-white" : "text-ash hover:text-ink",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {DOW.map((d) => (
          <div key={d} className="text-ash pb-1 text-center text-[11px] font-medium">
            {d}
          </div>
        ))}
        {weeks.flat().map((day, i) => {
          if (day == null) return <div key={`pad-${i}`} aria-hidden />;
          const u = byDay.get(day);
          const bucket = heatBucket(u?.utilisation ?? 0);
          const isSelected = day === selectedDate;
          const dayNum = Number(day.slice(8, 10));
          return (
            <Link
              key={day}
              href={`/dashboard/venues/${venueId}/service-summary?date=${day}`}
              aria-current={isSelected ? "date" : undefined}
              className={cn(
                "rounded-input flex aspect-square flex-col items-center justify-center text-xs transition hover:opacity-80",
                HEAT_CLASS[bucket],
                isSelected && "ring-ink ring-2",
              )}
            >
              <span className="font-semibold tabular-nums">{dayNum}</span>
              {u && u.bookedCovers > 0 ? (
                <span className="text-[10px] tabular-nums opacity-80">{u.bookedCovers}</span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
