"use client";

import { useActionState, useState } from "react";

import { type BookingStatus } from "@/lib/bookings/state";

import {
  refundBookingAction,
  transitionBookingAction,
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

const STATUS_TINT: Record<BookingStatus, string> = {
  requested: "bg-amber-100 text-amber-800",
  confirmed: "bg-blue-100 text-blue-800",
  seated: "bg-emerald-100 text-emerald-800",
  finished: "bg-neutral-100 text-neutral-700",
  cancelled: "bg-neutral-100 text-neutral-500 line-through",
  no_show: "bg-rose-100 text-rose-800",
};

const ACTION_LABEL: Record<BookingStatus, string> = {
  requested: "Request",
  confirmed: "Confirm",
  seated: "Seat",
  finished: "Finish",
  cancelled: "Cancel",
  no_show: "No-show",
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
}: {
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
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="w-24 font-mono text-sm text-neutral-900 tabular-nums">
          {wallStart}
          <span className="text-neutral-400"> – </span>
          {wallEnd}
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-medium text-neutral-900">
            {guestFirstName} · party of {partySize}
          </span>
          {notes ? <span className="text-xs text-neutral-500">{notes}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TINT[status]}`}>
          {STATUS_LABEL[status]}
        </span>
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

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="to" value={to} />
      {needsReason ? (
        <input
          type="text"
          name="cancelledReason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-40 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-900"
        />
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs font-medium text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900 disabled:opacity-50"
      >
        {pending ? "…" : label}
      </button>
      {state.status === "error" ? (
        <span className="text-xs text-rose-600">{state.message}</span>
      ) : null}
    </form>
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
    return (
      <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800">
        Refunded · {state.refundId}
      </span>
    );
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 transition hover:border-rose-300 hover:text-rose-900"
      >
        Refund
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input
        type="text"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (≥ 3 chars)"
        minLength={3}
        maxLength={200}
        required
        className="w-48 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-900"
      />
      <button
        type="submit"
        disabled={pending || reason.trim().length < 3}
        className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 transition hover:border-rose-400 disabled:opacity-50"
      >
        {pending ? "Refunding…" : "Confirm refund"}
      </button>
      <button
        type="button"
        onClick={() => {
          setArmed(false);
          setReason("");
        }}
        className="text-xs text-neutral-500 hover:underline"
      >
        Cancel
      </button>
      {state.status === "error" ? (
        <span className="text-xs text-rose-600">{state.message}</span>
      ) : null}
    </form>
  );
}
