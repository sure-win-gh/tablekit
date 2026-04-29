"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import { Button, Field, Input, Textarea, cn } from "@/components/ui";

import { createBookingAction, type CreateBookingActionState } from "../actions";

export type TableOptionLite = { tableIds: string[]; tableLabels: string[] };

type SlotLite = {
  serviceId: string;
  serviceName: string;
  wallStart: string;
  options: TableOptionLite[];
};

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
      <h2 className="text-xl font-bold tracking-tight text-ink">New booking</h2>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Date" htmlFor="nb-date">
          <Input
            id="nb-date"
            type="date"
            value={date}
            onChange={(e) => navigate({ date: e.target.value })}
            size="sm"
            className="w-auto"
          />
        </Field>
        <Field label="Party size" htmlFor="nb-party">
          <Input
            id="nb-party"
            type="number"
            min={1}
            max={20}
            value={partySize}
            onChange={(e) => navigate({ party: Number(e.target.value) })}
            size="sm"
            className="w-20"
          />
        </Field>
      </div>

      {slots.length === 0 ? (
        <p className="rounded-card border border-dashed border-hairline p-4 text-sm text-ash">
          No availability for that date and party size. Try another date, party size, or check that
          a service is scheduled for this day of the week.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...byService.entries()].map(([svcName, list]) => (
            <div key={svcName}>
              <h3 className="text-sm font-semibold tracking-tight text-ink">{svcName}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {list.map((s) => {
                  const isPicked =
                    picked?.serviceId === s.serviceId && picked?.wallStart === s.wallStart;
                  const firstOption = s.options[0];
                  const optionLabel = firstOption
                    ? firstOption.tableLabels.join(" + ")
                    : "";
                  const altCount = s.options.length - 1;
                  return (
                    <button
                      key={`${s.serviceId}-${s.wallStart}`}
                      type="button"
                      onClick={() => navigate({ serviceId: s.serviceId, wallStart: s.wallStart })}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-input border px-3 py-1.5 text-sm font-semibold tabular-nums transition",
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2",
                        isPicked
                          ? "border-ink bg-ink text-white"
                          : "border-hairline text-ink hover:border-ink",
                      )}
                    >
                      <span>{s.wallStart}</span>
                      {optionLabel ? (
                        <span
                          className={cn(
                            "text-[10px] font-normal",
                            isPicked ? "text-white/80" : "text-ash",
                          )}
                        >
                          {optionLabel}
                          {altCount > 0 ? ` · +${altCount} more` : ""}
                        </span>
                      ) : null}
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
  options,
}: {
  venueId: string;
  serviceId: string;
  date: string;
  wallStart: string;
  partySize: number;
  options: TableOptionLite[];
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

  // Default to the first option (smallest-sufficient — same as the
  // server's first-fit). Hosts who want a different combo can flip
  // through alternates with a tiny switcher; the rest never see it.
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = options[selectedIdx] ?? options[0];
  const preferredTableIds = selected ? selected.tableIds.join(",") : "";
  const tableSummary = selected ? selected.tableLabels.join(" + ") : "";

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-card border border-hairline bg-white p-4"
    >
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="wallStart" value={wallStart} />
      <input type="hidden" name="partySize" value={partySize} />
      <input type="hidden" name="preferredTableIds" value={preferredTableIds} />

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight text-ink">
          Guest details — {wallStart} · party of {partySize}
          {tableSummary ? <span className="ml-1 text-ash">· {tableSummary}</span> : null}
        </h3>
        {options.length > 1 ? (
          <button
            type="button"
            onClick={() => setSelectedIdx((i) => (i + 1) % options.length)}
            className="rounded-pill border border-hairline px-2.5 py-0.5 text-xs font-medium text-ink hover:border-ink"
            aria-label="Try a different table combination"
          >
            Switch tables ({selectedIdx + 1} / {options.length})
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="nb-fn">
          <Input id="nb-fn" name="firstName" required autoComplete="given-name" />
        </Field>
        <Field label="Last name" htmlFor="nb-ln" optional>
          <Input id="nb-ln" name="lastName" autoComplete="family-name" />
        </Field>
        <Field label="Email" htmlFor="nb-email">
          <Input id="nb-email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Phone" htmlFor="nb-phone" optional>
          <Input id="nb-phone" name="phone" type="tel" autoComplete="tel" />
        </Field>
      </div>

      <Field label="Notes" htmlFor="nb-notes" optional>
        <Textarea id="nb-notes" name="notes" maxLength={500} rows={2} />
      </Field>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-sm text-rose">{state.message}</span>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create booking"}
        </Button>
      </div>
    </form>
  );
}
