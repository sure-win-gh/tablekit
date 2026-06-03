"use client";

import { useState } from "react";

import { cn } from "@/components/ui";
import { type OverviewSegment } from "@/lib/bookings/overview";
import { BOOKING_STATUSES, type BookingStatus } from "@/lib/bookings/state";
import { STATUS_FILL } from "@/lib/bookings/status-style";

const STATUS_LABEL: Record<BookingStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  seated: "Seated",
  finished: "Finished",
  cancelled: "Cancelled",
  no_show: "No-show",
};

type DayOverviewProps = {
  // segments[0] is always the whole-day "All" view; the rest are one
  // per service, in the same order they appear in the list. Counts
  // reflect the rows currently loaded, so they respect any active
  // search / status filter — `filtersActive` lets the card say so.
  segments: OverviewSegment[];
  filtersActive: boolean;
};

// Day-at-a-glance summary beside the bookings list (desktop only).
// Defaults to the whole day, with a toggle to drill into each service.
export function DayOverview({ segments, filtersActive }: DayOverviewProps) {
  const [selectedKey, setSelectedKey] = useState("all");
  const active = segments.find((s) => s.key === selectedKey) ?? segments[0];
  // Only worth a toggle when there's more than one service — otherwise
  // "All" and the lone service are the same numbers.
  const showToggle = segments.length > 2;

  if (!active) return null;

  return (
    <div className="rounded-card border-hairline flex flex-col gap-4 border bg-white p-4">
      <h3 className="text-ink text-sm font-semibold tracking-tight">
        {filtersActive ? "Filtered overview" : "Day overview"}
      </h3>

      {showToggle ? (
        <div className="flex flex-wrap gap-1.5">
          {segments.map((s) => {
            const on = s.key === active.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setSelectedKey(s.key)}
                aria-pressed={on}
                className={cn(
                  "rounded-pill border px-2.5 py-1 text-xs font-medium transition",
                  on
                    ? "border-ink bg-ink text-white"
                    : "border-hairline text-ink hover:border-ink bg-white",
                )}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Bookings" value={active.total} />
        <Stat label="Covers" value={active.covers} hint="excl. cancelled / no-show" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-ash text-[11px] font-semibold tracking-wider uppercase">
          By status
        </span>
        {active.total === 0 ? (
          <p className="text-ash text-xs">Nothing on the books.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {BOOKING_STATUSES.filter((s) => (active.statusCounts[s] ?? 0) > 0).map((s) => (
              <li key={s} className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "rounded-pill inline-flex items-center border px-2 py-0.5 text-[11px] font-semibold",
                    STATUS_FILL[s],
                  )}
                >
                  {STATUS_LABEL[s]}
                </span>
                <span className="text-ink font-mono text-sm tabular-nums">
                  {active.statusCounts[s]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {active.noTableCount > 0 ? (
        <div className="rounded-card flex items-center justify-between gap-2 border border-amber-300 bg-amber-50 px-3 py-2">
          <span className="text-xs font-medium text-amber-900">Without a table</span>
          <span className="font-mono text-sm font-semibold text-amber-900 tabular-nums">
            {active.noTableCount}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-card border-hairline bg-cloud flex flex-col gap-0.5 border p-3">
      <span className="text-ink font-mono text-2xl font-bold tabular-nums">{value}</span>
      <span className="text-ash text-[11px] font-semibold tracking-wider uppercase">{label}</span>
      {hint ? <span className="text-ash text-[10px]">{hint}</span> : null}
    </div>
  );
}
