"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { createBookingAction, type CreateBookingActionState } from "../actions";

type SlotLite = { serviceId: string; serviceName: string; wallStart: string };

// ---------------------------------------------------------------------------
// Date + party + slot grid. All URL-driven so the server component re-
// renders after each pick — no client-side booking state.
// ---------------------------------------------------------------------------

export function SlotPicker({
  venueId,
  date,
  partySize,
  slots,
  picked,
}: {
  venueId: string;
  date: string;
  partySize: number;
  slots: SlotLite[];
  picked: { serviceId: string; wallStart: string } | null;
}) {
  const router = useRouter();

  function navigate(
    patch: Partial<{ date: string; party: number; serviceId: string; wallStart: string }>,
  ) {
    const sp = new URLSearchParams();
    sp.set("date", patch.date ?? date);
    sp.set("party", String(patch.party ?? partySize));
    if (patch.serviceId) sp.set("serviceId", patch.serviceId);
    if (patch.wallStart) sp.set("wallStart", patch.wallStart);
    router.push(`/dashboard/venues/${venueId}/bookings/new?${sp.toString()}`);
  }

  // Group slots by service for display.
  const byService = new Map<string, SlotLite[]>();
  for (const s of slots) {
    const list = byService.get(s.serviceName) ?? [];
    list.push(s);
    byService.set(s.serviceName, list);
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">New booking</h2>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => navigate({ date: e.target.value })}
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Party size</span>
          <input
            type="number"
            min={1}
            max={20}
            value={partySize}
            onChange={(e) => navigate({ party: Number(e.target.value) })}
            className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
      </div>

      {slots.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          No availability for that date and party size. Try another date, party size, or check that
          a service is scheduled for this day of the week.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...byService.entries()].map(([svcName, list]) => (
            <div key={svcName}>
              <h3 className="text-sm font-semibold tracking-tight text-neutral-700">{svcName}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {list.map((s) => {
                  const isPicked =
                    picked?.serviceId === s.serviceId && picked?.wallStart === s.wallStart;
                  return (
                    <button
                      key={`${s.serviceId}-${s.wallStart}`}
                      type="button"
                      onClick={() => navigate({ serviceId: s.serviceId, wallStart: s.wallStart })}
                      className={`rounded-md border px-3 py-1.5 text-sm font-medium tabular-nums transition ${
                        isPicked
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
                      }`}
                    >
                      {s.wallStart}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guest details form.
// ---------------------------------------------------------------------------

export function NewBookingForm({
  venueId,
  serviceId,
  date,
  wallStart,
  partySize,
}: {
  venueId: string;
  serviceId: string;
  date: string;
  wallStart: string;
  partySize: number;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<CreateBookingActionState, FormData>(
    async (prev, form) => {
      const r = await createBookingAction(prev, form);
      if (r.status === "created") {
        router.push(`/dashboard/venues/${venueId}/bookings?date=${date}`);
      }
      return r;
    },
    { status: "idle" },
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-md border border-neutral-200 p-4"
    >
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="wallStart" value={wallStart} />
      <input type="hidden" name="partySize" value={partySize} />

      <div>
        <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
          Guest details — {wallStart} · party of {partySize}
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" name="firstName" required autoComplete="given-name" />
        <Field label="Last name" name="lastName" autoComplete="family-name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Field label="Phone (optional)" name="phone" type="tel" autoComplete="tel" />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-700">Notes (optional)</span>
        <textarea
          name="notes"
          maxLength={500}
          rows={2}
          className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
        />
      </label>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-sm text-rose-600">{state.message}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create booking"}
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
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-700">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        autoComplete={autoComplete}
        className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
      />
    </label>
  );
}
