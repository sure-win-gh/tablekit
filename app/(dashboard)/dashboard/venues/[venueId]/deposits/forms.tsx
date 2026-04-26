"use client";

import { useActionState } from "react";

import { createDepositRule, deleteDepositRule } from "./actions";
import type { ActionState } from "./types";

type ServiceOption = { id: string; name: string };

const DAYS_LONG: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export function NewDepositRuleForm({
  venueId,
  services,
  chargesEnabled,
}: {
  venueId: string;
  services: ServiceOption[];
  chargesEnabled: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createDepositRule, {
    status: "idle",
  });
  if (!chargesEnabled) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Connect a Stripe account and complete onboarding before you can add deposit rules.
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border border-hairline p-4">
      <h3 className="text-sm font-semibold tracking-tight text-ink">New deposit rule</h3>
      <input type="hidden" name="venue_id" value={venueId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-charcoal">Service (leave blank for all)</span>
          <select
            name="service_id"
            className="rounded-md border border-hairline px-2 py-1 text-ink"
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
          <span className="text-charcoal">Kind</span>
          <select
            name="kind"
            defaultValue="per_cover"
            className="rounded-md border border-hairline px-2 py-1 text-ink"
          >
            <option value="per_cover">Per cover (deposit)</option>
            <option value="flat">Flat (deposit)</option>
            <option value="card_hold">Card hold (charge on no-show)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-charcoal">Amount (pence)</span>
          <input
            type="number"
            name="amount_minor"
            min={1}
            max={100000}
            defaultValue={2000}
            required
            className="rounded-md border border-hairline px-2 py-1 text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-charcoal">Refund window (hours)</span>
          <input
            type="number"
            name="refund_window_hours"
            min={0}
            max={168}
            defaultValue={24}
            className="rounded-md border border-hairline px-2 py-1 text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-charcoal">Min party</span>
          <input
            type="number"
            name="min_party"
            min={1}
            max={50}
            defaultValue={1}
            className="rounded-md border border-hairline px-2 py-1 text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-charcoal">Max party (blank = any)</span>
          <input
            type="number"
            name="max_party"
            min={1}
            max={50}
            className="rounded-md border border-hairline px-2 py-1 text-ink"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="text-charcoal">Days</legend>
        <div className="flex flex-wrap gap-2 pt-1">
          {DAYS_LONG.map((d) => (
            <label
              key={d.value}
              className="flex items-center gap-1 rounded-md border border-hairline px-2 py-1"
            >
              <input type="checkbox" name="day_of_week" value={d.value} defaultChecked />
              <span>{d.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-sm text-rose">{state.message}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-charcoal disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add rule"}
        </button>
      </div>
    </form>
  );
}

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
  const dayLabels = rule.dayOfWeek
    .sort()
    .map((d) => DAYS_LONG.find((x) => x.value === d)?.label ?? String(d))
    .join(" ");
  return (
    <div className="flex items-center justify-between border-b border-hairline py-3">
      <div className="flex flex-col text-sm">
        <span className="font-medium text-ink">
          {rule.kind === "per_cover"
            ? `£${(rule.amountMinor / 100).toFixed(2)} per cover`
            : rule.kind === "card_hold"
              ? `£${(rule.amountMinor / 100).toFixed(2)} card hold`
              : `£${(rule.amountMinor / 100).toFixed(2)} flat`}
          {" · "}
          {serviceName ?? "All services"}
        </span>
        <span className="text-ash">
          Party {rule.minParty}–{rule.maxParty ?? "∞"} · {dayLabels} · {rule.refundWindowHours}h
          refund window
        </span>
      </div>
      <form action={action}>
        <input type="hidden" name="rule_id" value={rule.id} />
        <input type="hidden" name="venue_id" value={venueId} />
        <button
          type="submit"
          disabled={pending}
          className="text-sm text-rose hover:underline disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
      </form>
    </div>
  );
}
