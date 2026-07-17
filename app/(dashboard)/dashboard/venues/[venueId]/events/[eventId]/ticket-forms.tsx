"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { refundBookingAction } from "@/app/(dashboard)/dashboard/venues/[venueId]/bookings/actions";

import { createTicketType, deleteTicketType } from "./ticket-actions";
import type { ActionState } from "../types";

// ---------------------------------------------------------------------------
// New ticket type — pounds entered, a synced hidden input posts pence.
// ---------------------------------------------------------------------------
export function NewTicketTypeForm({
  eventId,
  venueId,
  startOpen,
  coversHint,
}: {
  eventId: string;
  venueId: string;
  startOpen: boolean;
  // Total max covers of the event's scoped areas, when area-scoped. A hint
  // only — never enforced (spec §Tickets stay GA).
  coversHint?: number | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createTicketType, {
    status: "idle",
  });
  const [open, setOpen] = useState(startOpen);
  const [pounds, setPounds] = useState("45.00");
  const priceMinor = Math.round((Number.parseFloat(pounds) || 0) * 100);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-4 py-2 text-sm font-semibold transition"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add ticket type
        </button>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="border-hairline rounded-card flex flex-col gap-4 border bg-white p-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-ink text-sm font-bold tracking-tight">New ticket type</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ash hover:text-ink text-xs font-semibold transition"
        >
          Cancel
        </button>
      </div>
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="venue_id" value={venueId} />
      <input type="hidden" name="price_minor" value={priceMinor} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-ink text-xs font-medium">Name</span>
          <input
            type="text"
            name="name"
            required
            maxLength={60}
            placeholder="e.g. Standard, VIP table"
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Price</span>
          <span className="relative">
            <span className="text-ash absolute inset-y-0 left-3 flex items-center text-sm">£</span>
            <input
              type="number"
              value={pounds}
              onChange={(e) => setPounds(e.target.value)}
              min={0.01}
              step={0.01}
              required
              inputMode="decimal"
              className="border-hairline text-ink rounded-input w-full border py-2 pr-3 pl-7 text-sm tabular-nums"
            />
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Capacity</span>
          <input
            type="number"
            name="quantity_total"
            min={1}
            max={100000}
            defaultValue={60}
            required
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm tabular-nums"
          />
          {coversHint != null ? (
            <span className="text-ash text-[11px]">
              The blocked areas seat ~{coversHint} covers — a guide, not a limit.
            </span>
          ) : null}
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm sm:max-w-[12rem]">
        <span className="text-ink text-xs font-medium">Max per order</span>
        <input
          type="number"
          name="max_per_order"
          min={1}
          max={100}
          defaultValue={10}
          className="border-hairline text-ink rounded-input border px-3 py-2 text-sm tabular-nums"
        />
      </label>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span role="alert" className="text-rose text-sm">
            {state.message}
          </span>
        ) : null}
        {state.status === "saved" ? (
          <span className="text-sm text-emerald-600">Ticket type added.</span>
        ) : null}
        <button
          type="submit"
          disabled={pending || priceMinor < 1}
          className="bg-ink hover:bg-charcoal rounded-input px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add ticket type"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Ticket-type row — price + sold/total, two-step delete.
// ---------------------------------------------------------------------------
export function TicketTypeRow({
  type,
  eventId,
  venueId,
}: {
  type: {
    id: string;
    name: string;
    priceMinor: number;
    quantityTotal: number;
    quantitySold: number;
    maxPerOrder: number;
  };
  eventId: string;
  venueId: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(deleteTicketType, {
    status: "idle",
  });
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const price = `£${(type.priceMinor / 100).toFixed(2)}`;
  const remaining = type.quantityTotal - type.quantitySold;
  const soldOut = remaining <= 0;

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ink w-20 text-base font-bold tracking-tight tabular-nums">
          {price}
        </span>
        <span className="text-ink min-w-0 flex-1 truncate text-sm">
          {type.name}
          <span className="text-ash">
            {" · "}
            {type.quantitySold}/{type.quantityTotal} sold
            {soldOut ? (
              <span className="text-rose font-semibold"> · sold out</span>
            ) : (
              <span> · {remaining} left</span>
            )}
            {" · max "}
            {type.maxPerOrder}/order
          </span>
        </span>
        <form action={action} className="shrink-0">
          <input type="hidden" name="ticket_type_id" value={type.id} />
          <input type="hidden" name="event_id" value={eventId} />
          <input type="hidden" name="venue_id" value={venueId} />
          {confirming ? (
            <button
              type="submit"
              disabled={pending}
              className="rounded-pill border-rose/40 text-rose bg-rose/5 hover:bg-rose/10 border px-3 py-1 text-xs font-semibold transition disabled:opacity-50"
            >
              {pending ? "Deleting…" : "Confirm delete"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-ash hover:text-rose text-xs font-semibold transition"
            >
              Delete
            </button>
          )}
        </form>
      </div>
      {state.status === "error" ? (
        <p role="alert" className="text-[11px] text-amber-800">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendee row — event bookings live here, not on the bookings list (its
// services inner-join excludes them by design), so the refund entry point
// for tickets is this list. Two-step: Refund → reason + optional
// return-to-inventory → confirm. Reuses the shared refundBookingAction
// (which routes event_ticket payments through lib/payments/refunds).
// ---------------------------------------------------------------------------

export function AttendeeRow({
  venueId,
  bookingId,
  firstName,
  partySize,
  statusLabel,
  refundable,
}: {
  venueId: string;
  bookingId: string;
  firstName: string;
  partySize: number;
  statusLabel: string;
  refundable: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(refundBookingAction, { status: "idle" as const });
  const [open, setOpen] = useState(false);

  // Refresh the page data once the refund lands so the sold counts (and,
  // if tickets were returned, remaining capacity) update in place.
  useEffect(() => {
    if (state.status === "done") router.refresh();
  }, [state.status, router]);

  return (
    <div className="flex flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ink min-w-0 flex-1 truncate font-medium">{firstName}</span>
        <span className="text-ash tabular-nums">
          {partySize} ticket{partySize === 1 ? "" : "s"}
        </span>
        <span className="text-ash text-xs">{statusLabel}</span>
        {refundable && state.status !== "done" ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-ash hover:text-rose text-xs font-semibold transition"
          >
            {open ? "Cancel" : "Refund"}
          </button>
        ) : null}
        {state.status === "done" ? (
          <span className="text-xs font-semibold text-emerald-600">Refunded</span>
        ) : null}
      </div>
      {open && state.status !== "done" ? (
        <form
          action={action}
          className="rounded-card border-rose/30 bg-rose/5 flex flex-col gap-2 border p-3"
        >
          <input type="hidden" name="venueId" value={venueId} />
          <input type="hidden" name="bookingId" value={bookingId} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-ink font-medium">Refund reason</span>
            <input
              name="reason"
              required
              minLength={3}
              maxLength={200}
              placeholder="e.g. guest can no longer attend"
              className="border-hairline text-ink rounded-input border bg-white px-3 py-2 text-sm"
            />
            <span className="text-ash text-[11px]">Recorded in the audit log.</span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" name="returnTickets" className="mt-0.5" />
            <span className="text-charcoal">
              <span className="text-ink font-semibold">Return tickets to inventory</span> — puts
              these {partySize} ticket{partySize === 1 ? "" : "s"} back on sale.
            </span>
          </label>
          {state.status === "error" ? (
            <p role="alert" className="text-rose text-xs">
              {state.message}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={pending}
              className="rounded-input border-rose/40 text-rose bg-rose/5 hover:bg-rose/10 border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50"
            >
              {pending ? "Refunding…" : "Confirm full refund"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
