"use client";

import { Check, Copy, ExternalLink, Pencil } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";

import { updateSpecialEvent } from "../actions";
import type { ActionState } from "../types";

// ---------------------------------------------------------------------------
// Public event URL — read-only display with a click-to-copy button. Mirrors
// the CopyBlock on the embed page (same insecure-context fallback) but sized
// for a single link row and paired with an "open in new tab" affordance.
// ---------------------------------------------------------------------------
export function EventUrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API throws in insecure contexts — fall back to selecting
      // the text so the operator can press Cmd/Ctrl+C themselves.
      const target = document.getElementById("event-public-url");
      if (target) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <code
          id="event-public-url"
          aria-label="Public event URL"
          className="rounded-card border-hairline bg-cloud text-ink flex-1 overflow-x-auto border px-4 py-3 text-xs"
        >
          {url}
        </code>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy public event URL"
          className="rounded-input border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-2 text-xs font-semibold transition"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
            </>
          )}
        </button>
      </div>
      <Link
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-coral inline-flex items-center gap-0.5 self-start text-xs hover:underline"
      >
        Open in new tab
        <ExternalLink className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit event — collapsed behind a button; opens a form pre-filled with the
// event's current details. Same fields as create (name/date/window/scope/
// description/ticket link/areas); status is managed separately by the
// publish toggle on the events list.
// ---------------------------------------------------------------------------
export function EditEventForm({
  event,
  areaOptions,
}: {
  event: {
    id: string;
    venueId: string;
    name: string;
    description: string | null;
    date: string; // venue-local YYYY-MM-DD
    scope: "whole_day" | "window";
    startTime: string; // venue-local HH:MM
    endTime: string; // venue-local HH:MM
    externalTicketUrl: string | null;
    areaIds: string[];
  };
  // Floor-plan areas for the scope chips. Chips render only with ≥2 areas
  // (with one area, scoping is meaningless — it IS the venue).
  areaOptions: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateSpecialEvent, {
    status: "idle",
  });
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"whole_day" | "window">(event.scope);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 self-start border bg-white px-4 py-2 text-sm font-semibold transition"
      >
        <Pencil className="h-4 w-4" aria-hidden />
        Edit details
      </button>
    );
  }

  return (
    <form
      action={action}
      className="border-hairline rounded-card flex flex-col gap-4 border bg-white p-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-ink text-sm font-bold tracking-tight">Edit event</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ash hover:text-ink text-xs font-semibold transition"
        >
          Close
        </button>
      </div>
      <input type="hidden" name="event_id" value={event.id} />
      <input type="hidden" name="venue_id" value={event.venueId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink text-xs font-medium">Event name</span>
        <input
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          defaultValue={event.name}
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
            defaultValue={event.date}
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
                defaultValue={event.startTime}
                className="border-hairline text-ink rounded-input border px-2 py-2 text-sm tabular-nums"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-ink text-xs font-medium">To</span>
              <input
                type="time"
                name="end_time"
                required
                defaultValue={event.endTime}
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

      {areaOptions.length >= 2 ? (
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="text-ink text-xs font-medium">Blocks which areas?</legend>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {areaOptions.map((a) => (
              <label key={a.id} className="cursor-pointer">
                <input
                  type="checkbox"
                  name="area_ids"
                  value={a.id}
                  defaultChecked={event.areaIds.includes(a.id)}
                  className="peer sr-only"
                />
                <span className="rounded-pill border-hairline text-ash peer-checked:border-ink peer-checked:bg-ink hover:border-ink inline-flex border bg-white px-3 py-1 text-xs font-semibold transition select-none peer-checked:text-white">
                  {a.name}
                </span>
              </label>
            ))}
          </div>
          <span className="text-ash text-[11px]">
            Leave all unticked to block the whole venue. Tick areas to close only those — the rest
            keeps taking standard bookings.
          </span>
        </fieldset>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink text-xs font-medium">
          Ticket link <span className="text-ash">(optional)</span>
        </span>
        <input
          type="url"
          name="external_ticket_url"
          placeholder="https://…"
          defaultValue={event.externalTicketUrl ?? ""}
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
          defaultValue={event.description ?? ""}
          className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
        />
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
          <span className="text-sm text-emerald-600">Changes saved.</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-charcoal rounded-input px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
