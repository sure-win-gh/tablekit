"use client";

import { Plus } from "lucide-react";
import { useActionState, useEffect, useState } from "react";

import { cn } from "@/components/ui";

import { createDepositRule, deleteDepositRule } from "./actions";
import type { ActionState } from "./types";

type ServiceOption = { id: string; name: string };

const DAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const KIND_META: Record<string, { label: string; help: string }> = {
  per_cover: {
    label: "Per cover",
    help: "Charged per guest when the booking is made — £5 per cover × party of 4 = £20 up front.",
  },
  flat: {
    label: "Flat",
    help: "One fixed amount per booking, charged when the booking is made.",
  },
  card_hold: {
    label: "Card hold",
    help: "Nothing is charged up front — the card is saved and only charged if the guest no-shows.",
  },
};

// ---------------------------------------------------------------------------
// New rule — collapsed behind a button (auto-open when the venue has no
// rules yet). Amount is entered in pounds; a synced hidden input posts
// pence so the server contract is unchanged.
// ---------------------------------------------------------------------------
export function NewDepositRuleForm({
  venueId,
  services,
  chargesEnabled,
  startOpen,
}: {
  venueId: string;
  services: ServiceOption[];
  chargesEnabled: boolean;
  startOpen: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createDepositRule, {
    status: "idle",
  });
  const [open, setOpen] = useState(startOpen);
  const [kind, setKind] = useState("per_cover");
  const [pounds, setPounds] = useState("20.00");
  const amountMinor = Math.round((Number.parseFloat(pounds) || 0) * 100);

  if (!chargesEnabled) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Connect a Stripe account and complete onboarding before you can add deposit rules — head to
        Settings → Billing.
      </div>
    );
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-4 py-2 text-sm font-semibold transition"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add rule
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
        <h3 className="text-ink text-sm font-bold tracking-tight">New deposit rule</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ash hover:text-ink text-xs font-semibold transition"
        >
          Cancel
        </button>
      </div>
      <input type="hidden" name="venue_id" value={venueId} />
      <input type="hidden" name="amount_minor" value={amountMinor} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Type</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
          >
            {Object.entries(KIND_META).map(([k, meta]) => (
              <option key={k} value={k}>
                {meta.label}
              </option>
            ))}
          </select>
          <span className="text-ash text-[11px]">{KIND_META[kind]?.help}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">
            Amount {kind === "per_cover" ? "per cover" : ""}
          </span>
          <span className="relative">
            <span className="text-ash absolute inset-y-0 left-3 flex items-center text-sm">£</span>
            <input
              type="number"
              value={pounds}
              onChange={(e) => setPounds(e.target.value)}
              min={0.01}
              max={1000}
              step={0.01}
              required
              inputMode="decimal"
              className="border-hairline text-ink rounded-input w-full border py-2 pr-3 pl-7 text-sm tabular-nums"
            />
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Service</span>
          <select
            name="service_id"
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Min party</span>
          <input
            type="number"
            name="min_party"
            min={1}
            max={50}
            defaultValue={1}
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Max party</span>
          <input
            type="number"
            name="max_party"
            min={1}
            max={50}
            placeholder="Any"
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink text-xs font-medium">Refund window (hours)</span>
          <input
            type="number"
            name="refund_window_hours"
            min={0}
            max={168}
            defaultValue={24}
            className="border-hairline text-ink rounded-input border px-3 py-2 text-sm tabular-nums"
          />
          <span className="text-ash text-[11px]">
            Cancel this long before the booking and the deposit refunds automatically.
          </span>
        </label>
      </div>

      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="text-ink text-xs font-medium">Days this rule applies</legend>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {DAYS.map((d) => (
            <label key={d.value} className="cursor-pointer">
              <input
                type="checkbox"
                name="day_of_week"
                value={d.value}
                defaultChecked
                className="peer sr-only"
              />
              <span className="rounded-pill border-hairline text-ash peer-checked:border-ink peer-checked:bg-ink hover:border-ink inline-flex border bg-white px-3 py-1 text-xs font-semibold transition select-none peer-checked:text-white">
                {d.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span role="alert" className="text-rose text-sm">
            {state.message}
          </span>
        ) : null}
        {state.status === "saved" ? (
          <span className="text-sm text-emerald-600">Rule added.</span>
        ) : null}
        <button
          type="submit"
          disabled={pending || amountMinor < 1}
          className="bg-ink hover:bg-charcoal rounded-input px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add rule"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rule card — amount + type chip up front, day pills, two-step delete.
// ---------------------------------------------------------------------------
export function DepositRuleRow({
  rule,
  serviceName,
  venueId,
}: {
  rule: {
    id: string;
    serviceId: string | null;
    minParty: number;
    maxParty: number | null;
    dayOfWeek: number[];
    kind: string;
    amountMinor: number;
    refundWindowHours: number;
  };
  serviceName: string | null;
  venueId: string;
}) {
  const [, action, pending] = useActionState<ActionState, FormData>(deleteDepositRule, {
    status: "idle",
  });
  const [confirming, setConfirming] = useState(false);

  // Arm the confirm step briefly, then relax back to a plain Delete so
  // a stray first click can't linger as a loaded gun.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const activeDays = new Set(rule.dayOfWeek);
  const everyDay = activeDays.size === 7;
  const amount = `£${(rule.amountMinor / 100).toFixed(2)}`;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="text-ink w-20 text-base font-bold tracking-tight tabular-nums">
        {amount}
      </span>
      <span
        className={cn(
          "rounded-pill border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
          rule.kind === "card_hold"
            ? "border-coral/40 text-coral-deep bg-coral/5"
            : "border-ink/20 text-ink bg-cloud",
        )}
      >
        {KIND_META[rule.kind]?.label ?? rule.kind}
      </span>
      <span className="text-ink min-w-0 flex-1 truncate text-sm">
        {serviceName ?? "All services"}
        <span className="text-ash">
          {" · party "}
          {rule.minParty}–{rule.maxParty ?? "any"}
          {" · "}
          {rule.refundWindowHours}h refund window
        </span>
      </span>
      <span className="flex gap-1" aria-label={everyDay ? "Every day" : "Selected days"}>
        {everyDay ? (
          <span className="text-ash text-[11px]">every day</span>
        ) : (
          DAYS.map((d) => (
            <span
              key={d.value}
              title={d.label}
              className={cn(
                "rounded-tag inline-flex h-5 w-5 items-center justify-center text-[10px] font-semibold",
                activeDays.has(d.value) ? "bg-ink text-white" : "bg-cloud text-stone",
              )}
            >
              {d.label[0]}
            </span>
          ))
        )}
      </span>
      <form action={action} className="shrink-0">
        <input type="hidden" name="rule_id" value={rule.id} />
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
  );
}
