"use client";

// Last-resort error boundary. Catches errors thrown in the root
// layout itself — the only place a normal `error.tsx` can't reach —
// so it must render its own <html>/<body>. Next.js only mounts this
// in production; in dev you still get the overlay.
//
// We never render the error message or stack: a diner or operator
// should see a calm, branded screen, not internals that help map the
// system. The digest is a server-correlated id, safe to surface so a
// user can quote it to support.

import { useEffect } from "react";

import { captureException } from "@/lib/observability/capture";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { boundary: "global-error" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          color: "#222222",
          fontFamily: '-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        }}
      >
        <main style={{ maxWidth: 480, padding: "2rem", textAlign: "center" }}>
          <p
            style={{
              color: "#ff385c",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            Something went wrong
          </p>
          <h1 style={{ marginTop: 12, fontSize: 28, fontWeight: 700, letterSpacing: "-0.01em" }}>
            We hit an unexpected error
          </h1>
          <p style={{ marginTop: 12, color: "#6a6a6a", lineHeight: 1.5 }}>
            Sorry — something broke on our end. The team has been notified. Please try again in a
            moment.
          </p>
          {error.digest ? (
            <p style={{ marginTop: 16, color: "#929292", fontSize: 13 }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 24,
              padding: "10px 20px",
              fontSize: 15,
              fontWeight: 600,
              color: "#ffffff",
              background: "#ff385c",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
