"use client";

import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { BookingDetailDialog } from "@/components/bookings/booking-detail-dialog";
import { GuestBadges } from "@/components/bookings/guest-badges";
import { Badge, Button, IconButton, Input, cn } from "@/components/ui";
import type { GuestEnrichment, VenueTableForDetail } from "@/lib/bookings/detail";
import { BOOKING_STATUSES, type BookingStatus } from "@/lib/bookings/state";

const STATUS_LABEL: Record<BookingStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  seated: "Seated",
  finished: "Finished",
  cancelled: "Cancelled",
  no_show: "No-show",
};

// Each booking-status maps to one of Badge's semantic tones. Picked
// to match how operators read the row at a glance: amber for
// "needs attention", emerald for "good news", rose for "bad news",
// muted for "history".
const STATUS_TONE: Record<
  BookingStatus,
  "warning" | "info" | "success" | "neutral" | "muted" | "danger"
> = {
  requested: "warning",
  confirmed: "info",
  seated: "success",
  finished: "neutral",
  cancelled: "muted",
  no_show: "danger",
};

type BookingRowProps = {
  venueId: string;
  date: string;
  bookingId: string;
  wallStart: string;
  wallEnd: string;
  durationMinutes: number;
  partySize: number;
  status: BookingStatus;
  guestId: string;
  guestFirstName: string;
  notes: string | null;
  serviceName: string;
  areaId: string;
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
  assignedTables: Array<{ id: string; label: string; areaName: string }>;
  allVenueTables: VenueTableForDetail[];
  enrichment: GuestEnrichment;
};

export function BookingRow({
  venueId,
  date,
  bookingId,
  wallStart,
  wallEnd,
  durationMinutes,
  partySize,
  status,
  guestId,
  guestFirstName,
  notes,
  serviceName,
  areaId,
  refundable,
  cardHold,
  noShowOutcome,
  assignedTables,
  allVenueTables,
  enrichment,
}: BookingRowProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const primaryTable = assignedTables[0];
  const noTable = assignedTables.length === 0;

  return (
    <li
      className={cn(
        "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        // Highlight bookings with no table so operators can spot them at
        // a glance. The status badge still tells them why (usually
        // cancelled — the DB frees tables on cancel).
        noTable && "bg-amber-50",
      )}
    >
      <div className="flex items-center gap-4">
        <div className="text-ink w-24 font-mono text-sm tabular-nums">
          {wallStart}
          <span className="text-stone"> – </span>
          {wallEnd}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-ink text-sm font-semibold">
            {guestFirstName} · party of {partySize}
          </span>
          {noTable ? (
            notes ? (
              <span className="text-ash text-xs">{notes}</span>
            ) : null
          ) : (
            <span className="text-ash text-xs">
              {assignedTables.map((t) => `${t.areaName} · ${t.label}`).join(", ")}
              {notes ? ` · ${notes}` : ""}
            </span>
          )}
          <GuestBadges {...enrichment} density="row" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        {noTable ? <Badge tone="warning">No table</Badge> : null}
        <Button variant="primary" size="sm" onClick={() => setDetailOpen(true)}>
          View Booking
        </Button>
      </div>
      {detailOpen ? (
        <BookingDetailDialog
          venueId={venueId}
          date={date}
          allVenueTables={allVenueTables}
          onClose={() => setDetailOpen(false)}
          booking={{
            id: bookingId,
            status,
            wallStart,
            wallEnd,
            durationMinutes,
            guestId,
            guestFirstName,
            partySize,
            notes,
            serviceName,
            tableId: primaryTable?.id ?? null,
            tableLabel: primaryTable?.label ?? null,
            areaId,
            refundable,
            cardHold,
            noShowOutcome,
            ...enrichment,
          }}
        />
      ) : null}
    </li>
  );
}

// Date navigator for the bookings page. Drives the ?date= query
// param; prev / today / next buttons + a native date input. Pure
// URL-driven — no local state needed.
export function DateNav({ venueId, date }: { venueId: string; date: string }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const setDate = (d: string) => router.push(`/dashboard/venues/${venueId}/bookings?date=${d}`);
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
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDate(today)}
        disabled={date === today}
      >
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

// Search + status-chip filters above the day's bookings. URL-driven —
// every change pushes a new URL so back/forward and bookmarks survive.
// Search debounces by 250 ms so each keystroke isn't a navigation.
export function BookingsFilters({
  venueId,
  date,
  initialQuery,
  activeStatuses,
}: {
  venueId: string;
  date: string;
  initialQuery: string;
  activeStatuses: BookingStatus[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);

  function pushParams(next: { q?: string; status?: BookingStatus[] }) {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    const nextQ = next.q !== undefined ? next.q : query;
    if (nextQ.trim()) params.set("q", nextQ.trim());
    const nextStatuses = next.status ?? activeStatuses;
    if (nextStatuses.length > 0) params.set("status", nextStatuses.join(","));
    router.push(`/dashboard/venues/${venueId}/bookings?${params.toString()}`);
  }

  // Debounced URL push for the search box.
  useEffect(() => {
    if (query === initialQuery) return;
    const t = setTimeout(() => pushParams({ q: query }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggleStatus = (s: BookingStatus) => {
    const next = activeStatuses.includes(s)
      ? activeStatuses.filter((x) => x !== s)
      : [...activeStatuses, s];
    pushParams({ status: next });
  };

  const clearAll = () => {
    setQuery("");
    pushParams({ q: "", status: [] });
  };

  const filtersActive = query.trim().length > 0 || activeStatuses.length > 0;

  return (
    <div className="rounded-card border-hairline flex flex-wrap items-center gap-2 border bg-white p-2">
      <div className="relative min-w-[200px] flex-1">
        <Search
          className="text-ash pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2"
          aria-hidden
        />
        <Input
          type="search"
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search first name, email, or notes…"
          aria-label="Search bookings"
          className="pl-7"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {BOOKING_STATUSES.map((s) => {
          const on = activeStatuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              aria-pressed={on}
              className={cn(
                "rounded-pill border px-2.5 py-1 text-xs font-medium transition",
                on
                  ? "border-ink bg-ink text-white"
                  : "border-hairline text-ink hover:border-ink bg-white",
              )}
            >
              {STATUS_LABEL[s]}
            </button>
          );
        })}
      </div>
      {filtersActive ? (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
