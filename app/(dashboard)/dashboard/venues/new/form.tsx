"use client";

import { useActionState } from "react";

import { Button, Field, Input, Select } from "@/components/ui";

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
      <Field label="Venue name" htmlFor="venue-name" error={fieldErrors?.["name"]?.[0]}>
        <Input
          id="venue-name"
          name="name"
          type="text"
          autoComplete="organization"
          required
          invalid={Boolean(fieldErrors?.["name"]?.[0])}
        />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-ink text-xs font-semibold">Venue type</legend>
        <div className="flex flex-col gap-2">
          {TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="rounded-card border-hairline has-checked:border-ink has-checked:bg-cloud flex cursor-pointer items-start gap-3 border p-3 transition"
            >
              <input
                type="radio"
                name="venue_type"
                value={opt.value}
                required
                defaultChecked={opt.value === "cafe"}
                className="accent-ink mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-ink text-sm font-semibold">{opt.label}</span>
                <span className="text-ash text-xs">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {fieldErrors?.["venueType"] ? (
          <span role="alert" className="text-rose text-[11px]">
            {fieldErrors["venueType"][0]}
          </span>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Timezone" htmlFor="venue-tz">
          <Select id="venue-tz" name="timezone" defaultValue="Europe/London">
            {TZ_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Locale" htmlFor="venue-locale">
          <Select id="venue-locale" name="locale" defaultValue="en-GB">
            {LOCALE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-rose text-sm">
          {state.message}
        </p>
      ) : null}

      <div className="border-hairline flex justify-end gap-3 border-t pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create venue"}
        </Button>
      </div>
    </form>
  );
}
