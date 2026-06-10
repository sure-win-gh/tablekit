"use client";

import { useActionState, useEffect, useRef } from "react";

import { uploadVenuePhoto, type PhotoActionState } from "./actions";

const initial: PhotoActionState = { status: "idle" };

export function PhotoUploadForm({ venueId, atLimit }: { venueId: string; atLimit: boolean }) {
  const [state, action, pending] = useActionState(uploadVenuePhoto, initial);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the file input after a successful upload so the next add starts clean.
  useEffect(() => {
    if (state.status === "saved") formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="border-hairline flex flex-col gap-3 rounded-md border p-4"
    >
      <input type="hidden" name="venue_id" value={venueId} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Add a photo</span>
          <input
            type="file"
            name="file"
            accept="image/jpeg,image/png,image/webp"
            required
            disabled={pending || atLimit}
            className="text-charcoal file:bg-ink text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Caption (optional)</span>
          <input
            name="caption"
            type="text"
            maxLength={200}
            placeholder="e.g. The terrace at sunset"
            disabled={pending || atLimit}
            className="border-hairline rounded-md border px-3 py-2 text-sm outline-none focus:border-neutral-900"
          />
        </label>
        <button
          type="submit"
          disabled={pending || atLimit}
          className="bg-ink hover:bg-charcoal h-9 rounded-md px-4 text-sm font-medium text-white transition disabled:opacity-50"
        >
          {pending ? "Uploading…" : "Upload"}
        </button>
      </div>
      {atLimit ? (
        <p className="text-ash text-xs">Photo limit reached — delete one to add another.</p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p role="status" className="text-sm text-green-700">
          Photo added.
        </p>
      ) : null}
    </form>
  );
}
