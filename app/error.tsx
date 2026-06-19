"use client";

// Route-segment error boundary for everything under the root layout.
// Renders inside the existing <html>/<body>, so we can use the design
// tokens (text-ink, text-coral, …) defined in globals.css.
//
// Like global-error, this never shows the error message or stack —
// only a branded message and the server-correlated digest. The error
// is reported to our observability sink in an effect.

import { useEffect } from "react";

import { captureException } from "@/lib/observability/capture";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { boundary: "app-error" });
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-coral text-xs font-semibold tracking-wider uppercase">
        Something went wrong
      </p>
      <h1 className="text-ink text-2xl font-bold tracking-tight">We hit an unexpected error</h1>
      <p className="text-ash leading-relaxed">
        Sorry — something broke on our end. The team has been notified. Please try again in a
        moment.
      </p>
      {error.digest ? (
        <p className="text-mute text-sm">
          Reference: <code>{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="bg-coral hover:bg-coral-deep rounded-input mt-3 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
      >
        Try again
      </button>
    </main>
  );
}
