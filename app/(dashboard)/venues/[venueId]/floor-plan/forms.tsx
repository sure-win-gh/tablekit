"use client";

import { useActionState } from "react";

import {
  createArea,
  createTable,
  deleteArea,
  deleteTable,
  updateArea,
  updateTable,
  type ActionState,
} from "./actions";

const idle: ActionState = { status: "idle" };

// Shared in-form feedback
function FormMessage({ state }: { state: ActionState }) {
  if (state.status === "error") {
    return (
      <p role="alert" className="text-xs text-red-600">
        {state.message}
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export function NewAreaForm({ venueId }: { venueId: string }) {
  const [state, action, pending] = useActionState(createArea, idle);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-md border border-dashed border-neutral-300 p-4"
    >
      <input type="hidden" name="venue_id" value={venueId} />
      <label className="flex flex-1 flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-900">New area</span>
        <input
          name="name"
          type="text"
          required
          maxLength={60}
          placeholder="Terrace"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add area"}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function AreaHeader({ areaId, name }: { areaId: string; name: string }) {
  const [updateState, updateAction, updatePending] = useActionState(updateArea, idle);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteArea, idle);

  return (
    <div className="flex items-center gap-2">
      <form action={updateAction} className="flex flex-1 items-center gap-2">
        <input type="hidden" name="area_id" value={areaId} />
        <input
          name="name"
          defaultValue={name}
          required
          maxLength={60}
          className="flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-lg font-medium text-neutral-900 hover:border-neutral-300 focus:border-neutral-900 focus:bg-white focus:outline-none"
        />
        <button
          type="submit"
          disabled={updatePending}
          className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
        >
          {updatePending ? "…" : "Save"}
        </button>
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="area_id" value={areaId} />
        <button
          type="submit"
          disabled={deletePending}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {deletePending ? "…" : "Delete area"}
        </button>
      </form>
      <FormMessage state={updateState.status === "error" ? updateState : deleteState} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function NewTableForm({ areaId }: { areaId: string }) {
  const [state, action, pending] = useActionState(createTable, idle);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm"
    >
      <input type="hidden" name="area_id" value={areaId} />
      <NumField label="label" name="label" type="text" defaultValue="" required maxLength={30} />
      <NumField label="min" name="min_cover" type="number" defaultValue="2" min={1} max={40} />
      <NumField label="max" name="max_cover" type="number" defaultValue="4" min={1} max={40} />
      <ShapeField />
      <NumField label="x" name="x" type="number" defaultValue="0" min={0} max={100} />
      <NumField label="y" name="y" type="number" defaultValue="0" min={0} max={100} />
      <NumField label="w" name="w" type="number" defaultValue="2" min={1} max={40} />
      <NumField label="h" name="h" type="number" defaultValue="2" min={1} max={40} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add table"}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function TableRow({
  tableId,
  label,
  minCover,
  maxCover,
  shape,
  position,
}: {
  tableId: string;
  label: string;
  minCover: number;
  maxCover: number;
  shape: string;
  position: { x: number; y: number; w: number; h: number };
}) {
  const [updateState, updateAction, updatePending] = useActionState(updateTable, idle);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteTable, idle);

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-neutral-100 py-2 text-sm">
      <form action={updateAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="table_id" value={tableId} />
        <NumField
          label="label"
          name="label"
          type="text"
          defaultValue={label}
          required
          maxLength={30}
        />
        <NumField
          label="min"
          name="min_cover"
          type="number"
          defaultValue={String(minCover)}
          min={1}
          max={40}
        />
        <NumField
          label="max"
          name="max_cover"
          type="number"
          defaultValue={String(maxCover)}
          min={1}
          max={40}
        />
        <ShapeField defaultValue={shape === "circle" ? "circle" : "rect"} />
        <NumField
          label="x"
          name="x"
          type="number"
          defaultValue={String(position.x)}
          min={0}
          max={100}
        />
        <NumField
          label="y"
          name="y"
          type="number"
          defaultValue={String(position.y)}
          min={0}
          max={100}
        />
        <NumField
          label="w"
          name="w"
          type="number"
          defaultValue={String(position.w)}
          min={1}
          max={40}
        />
        <NumField
          label="h"
          name="h"
          type="number"
          defaultValue={String(position.h)}
          min={1}
          max={40}
        />
        <button
          type="submit"
          disabled={updatePending}
          className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
        >
          {updatePending ? "…" : "Save"}
        </button>
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="table_id" value={tableId} />
        <button
          type="submit"
          disabled={deletePending}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
        >
          {deletePending ? "…" : "Delete"}
        </button>
      </form>
      <FormMessage state={updateState.status === "error" ? updateState : deleteState} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field primitives
// ---------------------------------------------------------------------------

type NumFieldProps = {
  label: string;
  name: string;
  type: "text" | "number";
  defaultValue: string;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
};

function NumField({
  label,
  name,
  type,
  defaultValue,
  required,
  min,
  max,
  maxLength,
}: NumFieldProps) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-neutral-500">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
        className={`rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900 outline-none focus:border-neutral-900 ${type === "number" ? "w-16" : "w-24"}`}
      />
    </label>
  );
}

function ShapeField({ defaultValue = "rect" }: { defaultValue?: string }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-neutral-500">
      <span>shape</span>
      <select
        name="shape"
        defaultValue={defaultValue}
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-900 outline-none focus:border-neutral-900"
      >
        <option value="rect">rect</option>
        <option value="circle">circle</option>
      </select>
    </label>
  );
}
