"use client";

import { ExternalLink, Plus } from "lucide-react";
import { useActionState, useEffect, useState } from "react";

import { cn } from "@/components/ui";

import { createSpecialEvent, deleteSpecialEvent, setSpecialEventStatus } from "./actions";
import type { ActionState } from "./types";

type EventStatus = "draft" | "published" | "cancelled";

const STATUS_META: Record<EventStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "border-ink/20 text-ash bg-cloud" },
  published: { label: "Published", className: "border-emerald-300 text-emerald-700 bg-emerald-50" },
  cancelled: { label: "Cancelled", className: "border-rose/40 text-rose bg-rose/5" },
};

// ---------------------------------------------------------------------------
// New event — collapsed behind a button (auto-open when there are none yet).
// ---------------------------------------------------------------------------
export function NewEventForm({ venueId, startOpen }: { venueId: string; startOpen: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createSpecialEvent, {
    status: "idle",
  });
  const [open, setOpen] = useState(startOpen);
  const [scope, setScope] = useState<"whole_day" | "window">("whole_day");

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-4 py-2 text-sm font-semibold transition"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add event
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
        <h3 className="text-ink text-sm font-bold tracking-tight">New special event</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ash hover:text-ink text-xs font-semibold transition"
        >
          Cancel
        </button>
      </div>
      <input type="hidden" name="venue_id" value={venueId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink text-xs font-medium">Event name</span>
        <input
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="e.g. Beaujolais Day"
          className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Date</span>
          <input
            type="date"
            name="date"
            required
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Blocks</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "whole_day" | "window")}
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
          >
            <option value="whole_day">Whole day</option>
            <option value="window">Time window</option>
          </select>
          <input type="hidden" name="scope" value={scope} />
        </label>

        {scope === "window" ? (
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-ink text-xs font-medium">From</span>
              <input
                type="time"
                name="start_time"
                required
                className="border-hairline text-ink rounded-input border px-2 py-2 text-sm tabular-nums"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-ink text-xs font-medium">To</span>
              <input
                type="time"
                name="end_time"
                required
                className="border-hairline text-ink rounded-input border px-2 py-2 text-sm tabular-nums"
              />
            </label>
          </div>
        ) : (
          <div className="text-ash self-end pb-2 text-[11px]">
            Closes the whole day to standard bookings.
          </div>
        )}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink text-xs font-medium">
          Ticket link <span className="text-ash">(optional)</span>
        </span>
        <input
          type="url"
          name="external_ticket_url"
          placeholder="https://…"
          className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
        />
        <span className="text-ash text-[11px]">
          Where guests buy tickets while native ticketing is on the way (Eventbrite, your own
          page…).
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink text-xs font-medium">
          Description <span className="text-ash">(optional)</span>
        </span>
        <textarea
          name="description"
          rows={3}
          maxLength={4000}
          className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
        />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="publish" defaultChecked className="mt-0.5" />
        <span className="text-charcoal">
          <span className="text-ink font-semibold">Publish now</span> — immediately closes the
          booking widget for this date. Leave unticked to save as a draft.
        </span>
      </label>

      {state.status === "saved" && state.warning ? (
        <div
          role="alert"
          className="rounded-input border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {state.warning}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span role="alert" className="text-rose text-sm">
            {state.message}
          </span>
        ) : null}
        {state.status === "saved" && !state.warning ? (
          <span className="text-sm text-emerald-600">Event saved.</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-charcoal rounded-input px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save event"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Event row — date + status up front, publish toggle, two-step delete.
// ---------------------------------------------------------------------------
export function EventRow({
  event,
  venueId,
}: {
  event: {
    id: string;
    name: string;
    slug: string;
    status: EventStatus;
    externalTicketUrl: string | null;
    dateLabel: string;
    timeLabel: string;
  };
  venueId: string;
}) {
  const [statusState, statusAction, statusPending] = useActionState<ActionState, FormData>(
    setSpecialEventStatus,
    { status: "idle" },
  );
  const [, deleteAction, deletePending] = useActionState<ActionState, FormData>(
    deleteSpecialEvent,
    { status: "idle" },
  );
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const meta = STATUS_META[event.status];
  const nextStatus = event.status === "published" ? "draft" : "published";
  const toggleLabel = event.status === "published" ? "Unpublish" : "Publish";

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ink w-40 text-sm font-semibold tracking-tight tabular-nums">
          {event.dateLabel}
        </span>
        <span
          className={cn(
            "rounded-pill border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
            meta.className,
          )}
        >
          {meta.label}
        </span>
        <span className="text-ink min-w-0 flex-1 truncate text-sm">
          {event.name}
          <span className="text-ash">
            {" · "}
            {event.timeLabel}
          </span>
          {event.externalTicketUrl ? (
            <a
              href={event.externalTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-coral hover:text-coral-deep ml-2 inline-flex items-center gap-0.5 text-xs font-semibold"
            >
              Tickets
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : null}
        </span>

        {event.status !== "cancelled" ? (
          <form action={statusAction} className="shrink-0">
            <input type="hidden" name="event_id" value={event.id} />
            <input type="hidden" name="venue_id" value={venueId} />
            <input type="hidden" name="status" value={nextStatus} />
            <button
              type="submit"
              disabled={statusPending}
              className="text-ash hover:text-ink text-xs font-semibold transition disabled:opacity-50"
            >
              {statusPending ? "…" : toggleLabel}
            </button>
          </form>
        ) : null}

        <form action={deleteAction} className="shrink-0">
          <input type="hidden" name="event_id" value={event.id} />
          <input type="hidden" name="venue_id" value={venueId} />
          {confirming ? (
            <button
              type="submit"
              disabled={deletePending}
              className="rounded-pill border-rose/40 text-rose bg-rose/5 hover:bg-rose/10 border px-3 py-1 text-xs font-semibold transition disabled:opacity-50"
            >
              {deletePending ? "Deleting…" : "Confirm delete"}
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
      {statusState.status === "saved" && statusState.warning ? (
        <p role="alert" className="text-[11px] text-amber-800">
          {statusState.warning}
        </p>
      ) : null}
    </div>
  );
}
