"use client";

import { useActionState } from "react";

import { createVenue, type CreateVenueState } from "./actions";

const initial: CreateVenueState = { status: "idle" };

// IANA tz + BCP-47 locale defaults for the UK-first operator. Users
// can override either, and we'll expand the options with i18n later.
const TZ_OPTIONS = ["Europe/London", "Europe/Dublin", "UTC"] as const;
const LOCALE_OPTIONS = ["en-GB", "en-IE", "en-US"] as const;

const TYPE_OPTIONS = [
  {
    value: "cafe",
    label: "Café",
    hint: "6 small tables, one service 08:00–17:00, 45-min turn.",
  },
  {
    value: "restaurant",
    label: "Restaurant",
    hint: "Main room + bar; Lunch and Dinner services, 90-min turn.",
  },
  {
    value: "bar_pub",
    label: "Bar or pub",
    hint: "Inside + outside areas; one service 12:00–23:00, 60-min turn.",
  },
] as const;

export function NewVenueForm() {
  const [state, formAction, pending] = useActionState(createVenue, initial);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <Field
        label="Venue name"
        name="name"
        type="text"
        autoComplete="organization"
        required
        error={fieldErrors?.["name"]?.[0]}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-900">Venue type</legend>
        <div className="flex flex-col gap-2">
          {TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-300 p-3 has-checked:border-neutral-900 has-checked:bg-neutral-50"
            >
              <input
                type="radio"
                name="venue_type"
                value={opt.value}
                required
                defaultChecked={opt.value === "cafe"}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-xs text-neutral-500">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {fieldErrors?.["venueType"] ? (
          <span role="alert" className="text-xs text-red-600">
            {fieldErrors["venueType"][0]}
          </span>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Timezone"
          name="timezone"
          defaultValue="Europe/London"
          options={TZ_OPTIONS}
        />
        <Select label="Locale" name="locale" defaultValue="en-GB" options={LOCALE_OPTIONS} />
      </div>

      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}

      <div className="flex justify-end gap-3 border-t border-neutral-200 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create venue"}
        </button>
      </div>
    </form>
  );
}

type FieldProps = {
  label: string;
  name: string;
  type: "text";
  autoComplete?: string;
  required?: boolean;
  error?: string | undefined;
};

function Field({ label, name, type, autoComplete, required, error }: FieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-neutral-900">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      />
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function Select({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-neutral-900">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
