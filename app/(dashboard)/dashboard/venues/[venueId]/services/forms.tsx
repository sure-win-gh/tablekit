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
        <span className="text-ash text-xs">Name</span>
        <input
          name="name"
          type="text"
          defaultValue={fields.name}
          required
          maxLength={60}
          className="border-hairline w-40 rounded-md border px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <fieldset className="flex flex-col gap-0.5">
        <legend className="text-ash text-xs">Days</legend>
        <div className="flex gap-1">
          {DAYS.map((d) => (
            <label
              key={d.value}
              className="border-hairline has-checked:bg-cloud flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs has-checked:border-neutral-900"
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
        <span className="text-ash text-xs">Start</span>
        <input
          name="start"
          type="time"
          defaultValue={fields.start}
          required
          className="border-hairline rounded-md border px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-ash text-xs">End</span>
        <input
          name="end"
          type="time"
          defaultValue={fields.end}
          required
          className="border-hairline rounded-md border px-2 py-1 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-ash text-xs">Turn (min)</span>
        <input
          name="turn_minutes"
          type="number"
          defaultValue={String(fields.turnMinutes)}
          min={15}
          max={480}
          required
          className="border-hairline w-20 rounded-md border px-2 py-1 text-sm outline-none focus:border-neutral-900"
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
      className="border-hairline flex flex-col gap-2 rounded-md border border-dashed p-4"
    >
      <input type="hidden" name="venue_id" value={venueId} />
      <p className="text-ink text-sm font-medium">Add a service</p>
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
          className="border-hairline text-ink hover:bg-cloud rounded-md border bg-white px-3 py-2 text-sm font-medium transition disabled:opacity-50"
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
    <div className="border-hairline flex flex-col gap-2 border-t py-3">
      <form action={updateAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="service_id" value={serviceId} />
        <ServiceFieldset fields={{ name, days, start, end, turnMinutes }} />
        <button
          type="submit"
          disabled={updatePending}
          className="text-ash hover:text-ink text-xs disabled:opacity-50"
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
