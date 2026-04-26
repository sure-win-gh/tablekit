"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import { Badge, Button, IconButton, Input, Select } from "@/components/ui";
import { type BookingStatus } from "@/lib/bookings/state";

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
  bookingId: string;
  wallStart: string;
  wallEnd: string;
  partySize: number;
  status: BookingStatus;
  actions: BookingStatus[];
  guestFirstName: string;
  notes: string | null;
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
  assignedTables: Array<{ id: string; label: string; areaName: string }>;
  moveTargets: Array<{ id: string; label: string; areaName: string }>;
};

export function BookingRow({
  venueId,
  bookingId,
  wallStart,
  wallEnd,
  partySize,
  status,
  actions,
  guestFirstName,
  notes,
  refundable,
  cardHold,
  noShowOutcome,
  assignedTables,
  moveTargets,
}: BookingRowProps) {
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
      </div>
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
