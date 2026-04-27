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
  reviewRequestEnabled: boolean;
  reviewRequestDelayHours: 24 | 48 | 72;
  googlePlaceId: string;
  escalationEnabled: boolean;
  escalationThreshold: 1 | 2 | 3;
  escalationEmail: string;
  showcaseEnabled: boolean;
};

export function VenueSettingsForm({
  venueId,
  name,
  timezone,
  locale,
  reviewRequestEnabled,
  reviewRequestDelayHours,
  googlePlaceId,
  escalationEnabled,
  escalationThreshold,
  escalationEmail,
  showcaseEnabled,
}: Props) {
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

      <fieldset className="flex flex-col gap-3 border-t border-hairline pt-4">
        <legend className="text-sm font-semibold text-ink">Review requests</legend>
        <p className="text-xs text-ash">
          Sent automatically after a booking finishes. You can adjust the delay or turn it off.
          Guests are always offered both a Google link and a private-feedback option, regardless
          of rating.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="review_request_enabled"
            defaultChecked={reviewRequestEnabled}
            className="h-4 w-4 rounded border-hairline"
          />
          <span>Send review requests after dining</span>
        </label>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Send delay"
            name="review_request_delay_hours"
            defaultValue={String(reviewRequestDelayHours)}
            options={["24", "48", "72"]}
          />
          <Field
            label="Google Place ID"
            name="google_place_id"
            defaultValue={googlePlaceId}
            error={fieldErrors?.["googlePlaceId"]?.[0]}
            optional
          />
        </div>
        <p className="text-xs text-ash">
          Find your Place ID at{" "}
          <a
            href="https://developers.google.com/maps/documentation/places/web-service/place-id"
            className="underline"
            target="_blank"
            rel="noopener"
          >
            developers.google.com/maps/.../place-id
          </a>
          . Leave blank to skip the Google link.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3 border-t border-hairline pt-4">
        <legend className="text-sm font-semibold text-ink">Public review showcase</legend>
        <p className="text-xs text-ash">
          Show recent 4★ and 5★ reviews on this venue&apos;s booking page. Only reviews where
          the guest ticked the consent box appear; we display first name + rating + comment,
          never email or last name.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="showcase_enabled"
            defaultChecked={showcaseEnabled}
            className="h-4 w-4 rounded border-hairline"
          />
          <span>Show consented reviews on the booking page</span>
        </label>
      </fieldset>

      <fieldset id="escalation" className="flex flex-col gap-3 border-t border-hairline pt-4">
        <legend className="text-sm font-semibold text-ink">Negative review alerts</legend>
        <p className="text-xs text-ash">
          Email a manager when a low-star review lands so you can reply or send a recovery offer
          quickly.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="escalation_enabled"
            defaultChecked={escalationEnabled}
            className="h-4 w-4 rounded border-hairline"
          />
          <span>Send an alert when a review at or below the threshold lands</span>
        </label>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Threshold"
            name="escalation_threshold"
            defaultValue={String(escalationThreshold)}
            options={["1", "2", "3"]}
          />
          <Field
            label="Alert email"
            name="escalation_email"
            defaultValue={escalationEmail}
            error={fieldErrors?.["escalationEmail"]?.[0]}
            optional
          />
        </div>
        <p className="text-xs text-ash">
          Threshold is the highest rating that triggers an alert (e.g. 2 alerts on 1- and 2-star).
          Leave the email blank to fall back to the org owner&apos;s address.
        </p>
      </fieldset>

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
  optional,
}: {
  label: string;
  name: string;
  defaultValue: string;
  error?: string | undefined;
  optional?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink">{label}</span>
      <input
        name={name}
        type="text"
        defaultValue={defaultValue}
        required={!optional}
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
