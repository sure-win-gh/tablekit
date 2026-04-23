"use client";

import { useActionState } from "react";

import { createService, deleteService, updateService, type ActionState } from "./actions";

const idle: ActionState = { status: "idle" };

const DAYS = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
] as const;

function FormMessage({ state }: { state: ActionState }) {
  if (state.status === "error") {
    return (
      <p role="alert" className="text-xs text-red-600">
        {state.message}
      </p>
    );
  }
  if (state.status === "saved") {
    return <p className="text-xs text-green-700">Saved.</p>;
  }
  return null;
}

type ServiceFields = {
  name: string;
  days: readonly string[];
  start: string;
  end: string;
  turnMinutes: number;
};

function ServiceFieldset({ fields }: { fields: ServiceFields }) {
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-neutral-500">Name</span>
        <input
          name="name"
          type="text"
          defaultValue={fields.name}
          required
          maxLength={60}
          className="w-40 rounded-md border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <fieldset className="flex flex-col gap-0.5">
        <legend className="text-xs text-neutral-500">Days</legend>
        <div className="flex gap-1">
          {DAYS.map((d) => (
            <label
              key={d.value}
              className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs has-checked:border-neutral-900 has-checked:bg-neutral-50"
            >
              <input
                type="checkbox"
                name="days"
                value={d.value}
                defaultChecked={fields.days.includes(d.value)}
                className="h-3 w-3"
              />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-neutral-500">Start</span>
        <input
          name="start"
          type="time"
          defaultValue={fields.start}
          required
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-neutral-500">End</span>
        <input
          name="end"
          type="time"
          defaultValue={fields.end}
          required
          className="rounded-md border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-xs text-neutral-500">Turn (min)</span>
        <input
          name="turn_minutes"
          type="number"
          defaultValue={String(fields.turnMinutes)}
          min={15}
          max={480}
          required
          className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>
    </div>
  );
}

export function NewServiceForm({ venueId }: { venueId: string }) {
  const [state, action, pending] = useActionState(createService, idle);
  return (
    <form
      action={action}
      className="flex flex-col gap-2 rounded-md border border-dashed border-neutral-300 p-4"
    >
      <input type="hidden" name="venue_id" value={venueId} />
      <p className="text-sm font-medium text-neutral-900">Add a service</p>
      <ServiceFieldset
        fields={{
          name: "",
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "18:00",
          end: "22:00",
          turnMinutes: 90,
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add service"}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function ServiceRow({
  serviceId,
  name,
  days,
  start,
  end,
  turnMinutes,
}: {
  serviceId: string;
} & ServiceFields) {
  const [updateState, updateAction, updatePending] = useActionState(updateService, idle);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteService, idle);

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-200 py-3">
      <form action={updateAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="service_id" value={serviceId} />
        <ServiceFieldset fields={{ name, days, start, end, turnMinutes }} />
        <button
          type="submit"
          disabled={updatePending}
          className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
        >
          {updatePending ? "…" : "Save"}
        </button>
      </form>
      <form action={deleteAction} className="flex items-center gap-3">
        <input type="hidden" name="service_id" value={serviceId} />
        <button
          type="submit"
          disabled={deletePending}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {deletePending ? "…" : "Delete service"}
        </button>
        <FormMessage state={updateState.status !== "idle" ? updateState : deleteState} />
      </form>
    </div>
  );
}
