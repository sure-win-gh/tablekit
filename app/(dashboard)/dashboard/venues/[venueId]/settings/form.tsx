"use client";

import { useActionState } from "react";

import { updateVenue, type UpdateVenueState } from "./actions";

const initial: UpdateVenueState = { status: "idle" };

const TZ_OPTIONS = ["Europe/London", "Europe/Dublin", "UTC"] as const;
const LOCALE_OPTIONS = ["en-GB", "en-IE", "en-US"] as const;

type Props = {
  venueId: string;
  name: string;
  timezone: string;
  locale: string;
};

export function VenueSettingsForm({ venueId, name, timezone, locale }: Props) {
  const [state, formAction, pending] = useActionState(updateVenue, initial);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <input type="hidden" name="venue_id" value={venueId} />

      <Field
        label="Venue name"
        name="name"
        defaultValue={name}
        error={fieldErrors?.["name"]?.[0]}
      />

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Timezone"
          name="timezone"
          defaultValue={
            TZ_OPTIONS.includes(timezone as (typeof TZ_OPTIONS)[number])
              ? timezone
              : "Europe/London"
          }
          options={TZ_OPTIONS}
        />
        <Select
          label="Locale"
          name="locale"
          defaultValue={
            LOCALE_OPTIONS.includes(locale as (typeof LOCALE_OPTIONS)[number]) ? locale : "en-GB"
          }
          options={LOCALE_OPTIONS}
        />
      </div>

      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="text-sm text-green-700">
          Saved.
        </p>
      ) : null}

      <div className="flex justify-end border-t border-hairline pt-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-charcoal disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  error,
}: {
  label: string;
  name: string;
  defaultValue: string;
  error?: string | undefined;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink">{label}</span>
      <input
        name={name}
        type="text"
        defaultValue={defaultValue}
        required
        aria-invalid={Boolean(error)}
        className="rounded-md border border-hairline px-3 py-2 text-sm outline-none focus:border-neutral-900"
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
      <span className="font-medium text-ink">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-hairline px-3 py-2 text-sm outline-none focus:border-neutral-900"
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
