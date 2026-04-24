"use client";

import { useActionState } from "react";

import {
  createDepositRule,
  deleteDepositRule,
  type ActionState,
} from "./actions";

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
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createDepositRule,
    { status: "idle" },
  );
  if (!chargesEnabled) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Connect a Stripe account and complete onboarding before you can add deposit rules.
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border border-neutral-200 p-4">
      <h3 className="text-sm font-semibold tracking-tight text-neutral-900">New deposit rule</h3>
      <input type="hidden" name="venue_id" value={venueId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Service (leave blank for all)</span>
          <select
            name="service_id"
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
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
          <span className="text-neutral-700">Kind</span>
          <select
            name="kind"
            defaultValue="per_cover"
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          >
            <option value="per_cover">Per cover</option>
            <option value="flat">Flat</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Amount (pence)</span>
          <input
            type="number"
            name="amount_minor"
            min={1}
            max={100000}
            defaultValue={2000}
            required
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Refund window (hours)</span>
          <input
            type="number"
            name="refund_window_hours"
            min={0}
            max={168}
            defaultValue={24}
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Min party</span>
          <input
            type="number"
            name="min_party"
            min={1}
            max={50}
            defaultValue={1}
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Max party (blank = any)</span>
          <input
            type="number"
            name="max_party"
            min={1}
            max={50}
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="text-neutral-700">Days</legend>
        <div className="flex flex-wrap gap-2 pt-1">
          {DAYS_LONG.map((d) => (
            <label
              key={d.value}
              className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1"
            >
              <input
                type="checkbox"
                name="day_of_week"
                value={d.value}
                defaultChecked
              />
              <span>{d.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-sm text-rose-600">{state.message}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
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
  const [, action, pending] = useActionState<ActionState, FormData>(
    deleteDepositRule,
    { status: "idle" },
  );
  const dayLabels = rule.dayOfWeek
    .sort()
    .map((d) => DAYS_LONG.find((x) => x.value === d)?.label ?? String(d))
    .join(" ");
  return (
    <div className="flex items-center justify-between border-b border-neutral-200 py-3">
      <div className="flex flex-col text-sm">
        <span className="font-medium text-neutral-900">
          {rule.kind === "per_cover" ? `£${(rule.amountMinor / 100).toFixed(2)} per cover` : `£${(rule.amountMinor / 100).toFixed(2)} flat`}
          {" · "}
          {serviceName ?? "All services"}
        </span>
        <span className="text-neutral-500">
          Party {rule.minParty}–{rule.maxParty ?? "∞"} · {dayLabels} · {rule.refundWindowHours}h refund window
        </span>
      </div>
      <form action={action}>
        <input type="hidden" name="rule_id" value={rule.id} />
        <input type="hidden" name="venue_id" value={venueId} />
        <button
          type="submit"
          disabled={pending}
          className="text-sm text-rose-600 hover:underline disabled:opacity-50"
        >
          {pending ? "Deleting…" : "Delete"}
        </button>
      </form>
    </div>
  );
}
