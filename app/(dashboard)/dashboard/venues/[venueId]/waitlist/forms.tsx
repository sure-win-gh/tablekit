"use client";

import { useActionState, useState } from "react";

import { addWaitlistAction, cancelWaitlistAction, seatWaitlistAction } from "./actions";
import type { ActionState } from "./types";

type TableOption = { id: string; label: string; areaName: string; maxCover: number };

export function NewWalkInForm({ venueId }: { venueId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addWaitlistAction, {
    status: "idle",
  });
  return (
    <form action={action} className="border-hairline flex flex-col gap-3 rounded-md border p-4">
      <h3 className="text-ink text-sm font-semibold tracking-tight">Add walk-in</h3>
      <input type="hidden" name="venue_id" value={venueId} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="First name" name="first_name" required />
        <Field label="Phone" name="phone" type="tel" required />
        <Field
          label="Party"
          name="party_size"
          type="number"
          required
          min={1}
          max={50}
          defaultValue="2"
        />
        <Field label="Notes" name="notes" />
      </div>
      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-rose text-xs">{state.message}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-charcoal rounded-md px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add to waitlist"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  defaultValue,
  min,
  max,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-charcoal">{label}</span>
      <input
        type={type}
        name={name}
        required={required}
        defaultValue={defaultValue}
        min={min}
        max={max}
        className="border-hairline text-ink rounded-md border px-2 py-1 text-sm"
      />
    </label>
  );
}

export function WaitlistEntryRow({
  entry,
  venueId,
  tables,
  waitMinutes,
}: {
  entry: {
    id: string;
    guestFirstName: string;
    partySize: number;
    notes: string | null;
    requestedAt: Date;
  };
  venueId: string;
  tables: TableOption[];
  waitMinutes: number;
}) {
  const eligibleTables = tables.filter((t) => t.maxCover >= entry.partySize);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col text-sm">
        <span className="text-ink font-medium">
          {entry.guestFirstName} · party of {entry.partySize}
        </span>
        <span className="text-ash text-xs">
          Waiting {minutesSince(entry.requestedAt)} min · est. wait {waitMinutes} min
          {entry.notes ? ` · ${entry.notes}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SeatNowControl venueId={venueId} waitlistId={entry.id} tables={eligibleTables} />
        <CancelControl venueId={venueId} waitlistId={entry.id} outcome="left" label="Left" />
        <CancelControl venueId={venueId} waitlistId={entry.id} outcome="cancelled" label="Cancel" />
      </div>
    </li>
  );
}

function SeatNowControl({
  venueId,
  waitlistId,
  tables,
}: {
  venueId: string;
  waitlistId: string;
  tables: TableOption[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(seatWaitlistAction, {
    status: "idle",
  });
  const [tableId, setTableId] = useState("");
  if (tables.length === 0) {
    return <span className="text-mute text-xs">No table fits</span>;
  }
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="venue_id" value={venueId} />
      <input type="hidden" name="waitlist_id" value={waitlistId} />
      <select
        name="table_id"
        value={tableId}
        onChange={(e) => setTableId(e.target.value)}
        className="border-hairline text-ink rounded-md border px-2 py-0.5 text-xs"
      >
        <option value="">Pick table…</option>
        {tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.areaName} · {t.label} (≤{t.maxCover})
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || !tableId}
        className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 transition hover:border-emerald-400 disabled:opacity-50"
      >
        {pending ? "Seating…" : "Seat now"}
      </button>
      {state.status === "error" ? <span className="text-rose text-xs">{state.message}</span> : null}
    </form>
  );
}

function CancelControl({
  venueId,
  waitlistId,
  outcome,
  label,
}: {
  venueId: string;
  waitlistId: string;
  outcome: "cancelled" | "left";
  label: string;
}) {
  const [, action, pending] = useActionState<ActionState, FormData>(cancelWaitlistAction, {
    status: "idle",
  });
  return (
    <form action={action}>
      <input type="hidden" name="venue_id" value={venueId} />
      <input type="hidden" name="waitlist_id" value={waitlistId} />
      <input type="hidden" name="outcome" value={outcome} />
      <button
        type="submit"
        disabled={pending}
        className="border-hairline text-charcoal hover:border-ink rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
      >
        {pending ? "…" : label}
      </button>
    </form>
  );
}

function minutesSince(d: Date): number {
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000));
}
