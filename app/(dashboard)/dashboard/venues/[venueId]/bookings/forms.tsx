"use client";

import { useActionState, useState } from "react";

import { type BookingStatus } from "@/lib/bookings/state";

import { transitionBookingAction, type TransitionActionState } from "./actions";

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
      <div className="flex items-center gap-2">
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
