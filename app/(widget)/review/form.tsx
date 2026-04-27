"use client";

import { useActionState, useState } from "react";

import { markRedirectedToGoogle, submitReview, type SubmitReviewState } from "./actions";

const initial: SubmitReviewState = { status: "idle" };

export function ReviewForm({
  p,
  s,
  mode,
}: {
  p: string;
  s: string;
  mode: "public" | "private";
}) {
  const [state, formAction, pending] = useActionState(submitReview, initial);
  const [rating, setRating] = useState<number>(0);

  if (state.status === "saved") {
    return <ThankYou state={state} p={p} s={s} mode={mode} />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="p" value={p} />
      <input type="hidden" name="s" value={s} />
      <input type="hidden" name="rating" value={rating} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Your rating</legend>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              aria-pressed={rating >= n}
              onClick={() => setRating(n)}
              className={`flex h-11 w-11 items-center justify-center rounded-md border text-2xl transition ${
                rating >= n
                  ? "border-ink bg-ink text-white"
                  : "border-hairline bg-white text-ash hover:border-ink"
              }`}
            >
              ★
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">
          {mode === "private" ? "Tell us what went wrong" : "Anything else (optional)"}
        </span>
        <textarea
          name="comment"
          rows={4}
          maxLength={800}
          className="rounded-md border border-hairline px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
      </label>

      {mode === "public" ? (
        <label className="flex items-start gap-2 text-sm text-ash">
          <input
            type="checkbox"
            name="showcase_consent"
            className="mt-0.5 h-4 w-4 rounded border-hairline"
          />
          <span>
            Let the venue show your first name, rating, and comment on their public booking
            page. You can ask them to take it down at any time.
          </span>
        </label>
      ) : null}

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending || rating === 0}
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-charcoal disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

function ThankYou({
  state,
  p,
  s,
  mode,
}: {
  state: Extract<SubmitReviewState, { status: "saved" }>;
  p: string;
  s: string;
  mode: "public" | "private";
}) {
  // De-emphasise (but never hide) the Google CTA on low ratings or
  // private-mode submits. Anti-gating: every submitter sees the same
  // button — copy and visual weight is what we tune.
  const lowRating = state.rating <= 3 || mode === "private";

  return (
    <div className="flex flex-col gap-4 rounded-md border border-neutral-200 bg-white p-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">Thanks — that&apos;s in.</h2>
        <p className="mt-1 text-sm text-ash">
          {lowRating
            ? "We'll read every word. If you'd like a reply, the venue can email you back directly."
            : "If you've a minute more, sharing it on Google really helps a small team."}
        </p>
      </div>
      {state.googleReviewUrl ? (
        <a
          href={state.googleReviewUrl}
          target="_blank"
          rel="noopener"
          onClick={() => {
            // Fire-and-forget — we don't block the redirect on its result.
            void markRedirectedToGoogle(p, s);
          }}
          className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition ${
            lowRating
              ? "border border-hairline bg-white text-ink hover:border-ink"
              : "bg-ink text-white hover:bg-charcoal"
          }`}
        >
          Share on Google
        </a>
      ) : null}
    </div>
  );
}
