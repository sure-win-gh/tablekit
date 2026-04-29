"use client";

import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { BookingDetailDialog } from "@/components/bookings/booking-detail-dialog";
import { Badge, Button, IconButton, Input, Select, cn } from "@/components/ui";
import type { VenueTableForDetail } from "@/lib/bookings/detail";
import { BOOKING_STATUSES, type BookingStatus } from "@/lib/bookings/state";

import {
  reassignTableAction,
  refundBookingAction,
  transitionBookingAction,
  type ReassignTableActionState,
  type RefundActionState,
  type TransitionActionState,
} from "./actions";

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
const STATUS_TONE: Record<BookingStatus, "warning" | "info" | "success" | "neutral" | "muted" | "danger"> = {
  requested: "warning",
  confirmed: "info",
  seated: "success",
  finished: "neutral",
  cancelled: "muted",
  no_show: "danger",
};

const ACTION_LABEL: Record<BookingStatus, string> = {
  requested: "Request",
  confirmed: "Confirm",
  seated: "Seat",
  finished: "Finish",
  cancelled: "Cancel",
  no_show: "No-show",
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
  actions: BookingStatus[];
  guestId: string;
  guestFirstName: string;
  notes: string | null;
  serviceName: string;
  areaId: string;
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
  assignedTables: Array<{ id: string; label: string; areaName: string }>;
  moveTargets: Array<{ id: string; label: string; areaName: string }>;
  allVenueTables: VenueTableForDetail[];
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
  actions,
  guestId,
  guestFirstName,
  notes,
  serviceName,
  areaId,
  refundable,
  cardHold,
  noShowOutcome,
  assignedTables,
  moveTargets,
  allVenueTables,
}: BookingRowProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const primaryTable = assignedTables[0];

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="w-24 font-mono text-sm tabular-nums text-ink">
          {wallStart}
          <span className="text-stone"> – </span>
          {wallEnd}
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-ink">
            {guestFirstName} · party of {partySize}
          </span>
          <span className="text-xs text-ash">
            {assignedTables.length === 0
              ? "No table"
              : assignedTables.map((t) => `${t.areaName} · ${t.label}`).join(", ")}
            {notes ? ` · ${notes}` : ""}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
        {assignedTables.length === 1 && moveTargets.length > 0 ? (
          <MoveTableControl
            venueId={venueId}
            bookingId={bookingId}
            fromTableId={assignedTables[0]!.id}
            targets={moveTargets}
          />
        ) : null}
        {cardHold && !noShowOutcome ? <Badge tone="info">Card on file</Badge> : null}
        {noShowOutcome === "captured" ? <Badge tone="success">No-show charged</Badge> : null}
        {noShowOutcome === "failed" ? <Badge tone="danger">Capture failed</Badge> : null}
        {actions.map((to) => (
          <TransitionButton
            key={to}
            venueId={venueId}
            bookingId={bookingId}
            to={to}
            label={ACTION_LABEL[to]}
          />
        ))}
        {refundable ? <RefundButton venueId={venueId} bookingId={bookingId} /> : null}
        {primaryTable ? (
          <Button variant="ghost" size="sm" onClick={() => setDetailOpen(true)}>
            Details
          </Button>
        ) : null}
      </div>
      {detailOpen && primaryTable ? (
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
            tableId: primaryTable.id,
            tableLabel: primaryTable.label,
            areaId,
            refundable,
            cardHold,
            noShowOutcome,
          }}
        />
      ) : null}
    </li>
  );
}

function TransitionButton({
  venueId,
  bookingId,
  to,
  label,
}: {
  venueId: string;
  bookingId: string;
  to: BookingStatus;
  label: string;
}) {
  const [state, formAction, pending] = useActionState<TransitionActionState, FormData>(
    transitionBookingAction,
    { status: "idle" },
  );
  const [reason, setReason] = useState("");
  const needsReason = to === "cancelled";
  // Cancel is the only "destructive" transition; the rest are
  // forward-flow and use the safe secondary look.
  const variant = to === "cancelled" ? "destructive" : "secondary";

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="to" value={to} />
      {needsReason ? (
        <Input
          type="text"
          name="cancelledReason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          size="sm"
          className="w-40"
        />
      ) : null}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? "…" : label}
      </Button>
      {state.status === "error" ? (
        <span className="text-xs text-rose">{state.message}</span>
      ) : null}
    </form>
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
    <div className="flex flex-wrap items-center gap-2 rounded-card border border-hairline bg-white p-2">
      <div className="relative flex-1 min-w-[200px]">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ash"
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
                  : "border-hairline bg-white text-ink hover:border-ink",
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

// Refund button. Inline reason capture (server enforces ≥3 chars).
// Two-step: click "Refund" to expand the reason input; click "Confirm
// refund" to submit. Avoids the full-modal pattern for an MVP UI while
// preventing one-click accidents. Shows the refund id on success and
// the (already-truncated) Stripe message on failure.
function RefundButton({ venueId, bookingId }: { venueId: string; bookingId: string }) {
  const [state, formAction, pending] = useActionState<RefundActionState, FormData>(
    refundBookingAction,
    { status: "idle" },
  );
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");

  if (state.status === "done") {
    return <Badge tone="success">Refunded · {state.refundId}</Badge>;
  }

  if (!armed) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setArmed(true)}>
        Refund
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <Input
        type="text"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (≥ 3 chars)"
        minLength={3}
        maxLength={200}
        required
        size="sm"
        className="w-48"
      />
      <Button
        type="submit"
        variant="destructive"
        size="sm"
        disabled={pending || reason.trim().length < 3}
      >
        {pending ? "Refunding…" : "Confirm refund"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setArmed(false);
          setReason("");
        }}
      >
        Cancel
      </Button>
      {state.status === "error" ? (
        <span className="text-xs text-rose">{state.message}</span>
      ) : null}
    </form>
  );
}

// Move-table control. Two-step interaction: dropdown picks the target;
// submitting the form fires reassignTableAction. Same-area only — the
// enforce_booking_tables_denorm trigger rejects cross-area moves and
// the action returns 'wrong-area' if the host somehow forces it.
function MoveTableControl({
  venueId,
  bookingId,
  fromTableId,
  targets,
}: {
  venueId: string;
  bookingId: string;
  fromTableId: string;
  targets: Array<{ id: string; label: string; areaName: string }>;
}) {
  const [state, action, pending] = useActionState<ReassignTableActionState, FormData>(
    reassignTableAction,
    { status: "idle" },
  );
  const [toTableId, setToTableId] = useState("");
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="fromTableId" value={fromTableId} />
      <Select
        name="toTableId"
        value={toTableId}
        onChange={(e) => setToTableId(e.target.value)}
        size="sm"
      >
        <option value="">Move to…</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.areaName} · {t.label}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="secondary" size="sm" disabled={pending || !toTableId}>
        {pending ? "…" : "Move"}
      </Button>
      {state.status === "error" ? (
        <span className="text-xs text-rose">{state.message}</span>
      ) : null}
    </form>
  );
}
