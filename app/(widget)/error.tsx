"use client";

// Error boundary for the diner-facing widget surfaces (/book, /embed,
// /review). These render on third-party sites and for the public, so
// a leaked stack trace here is the highest-risk case. Keep the copy
// minimal and reassuring; no internals, no "team has been notified"
// (the diner isn't our customer — the venue is).

import { useEffect } from "react";

import { captureException } from "@/lib/observability/capture";

export default function WidgetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { boundary: "widget-error" });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-ink text-xl font-bold tracking-tight">Booking unavailable</h1>
      <p className="text-ash leading-relaxed">
        We couldn&rsquo;t load the booking form just now. Please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="bg-coral hover:bg-coral-deep rounded-input mt-2 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
      >
        Try again
      </button>
    </main>
  );
}
