"use client";

import { useActionState } from "react";

import { pickGoogleLocation, type PickGoogleLocationState } from "./google-actions";

const initial: PickGoogleLocationState = { status: "idle" };

export type PickerLocation = {
  resourceName: string; // "accounts/{accId}/locations/{locId}"
  title: string;
  address: string | null;
};

export function GoogleLocationPicker({
  venueId,
  locations,
  loadError,
}: {
  venueId: string;
  locations: PickerLocation[];
  loadError: string | null;
}) {
  const [state, formAction, pending] = useActionState(pickGoogleLocation, initial);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline bg-cloud p-4">
      <p className="text-sm font-medium text-ink">Pick the location to sync</p>
      <p className="text-xs text-ash">
        Reviews and replies are scoped to one Google Business Profile location per TableKit venue.
      </p>
      {loadError ? (
        <p role="alert" className="text-xs text-red-600">
          {loadError}
        </p>
      ) : locations.length === 0 ? (
        <p className="text-xs text-ash">
          No locations were returned by Google for this account. Make sure your account manages at
          least one published location, then refresh.
        </p>
      ) : (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="venue_id" value={venueId} />
          <select
            name="location_resource"
            required
            className="rounded-md border border-hairline bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900"
            defaultValue=""
          >
            <option value="" disabled>
              Choose a location…
            </option>
            {locations.map((l) => (
              <option key={l.resourceName} value={l.resourceName}>
                {l.title}
                {l.address ? ` — ${l.address}` : ""}
              </option>
            ))}
          </select>
          {state.status === "error" ? (
            <p role="alert" className="text-xs text-red-600">
              {state.message}
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white hover:bg-charcoal disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save location"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
