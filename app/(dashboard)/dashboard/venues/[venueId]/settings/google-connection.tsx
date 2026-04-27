"use client";

import { useActionState } from "react";

import { disconnectGoogle, type DisconnectGoogleState } from "./google-actions";

const initial: DisconnectGoogleState = { status: "idle" };

const FLASH_LABELS: Record<string, string> = {
  connected: "Connected — we'll start syncing reviews shortly.",
  disconnected: "Disconnected from Google.",
  denied: "You denied access. Nothing was changed.",
  disabled: "Google Business Profile integration isn't enabled on this deployment.",
  "bad-request": "Couldn't read the request from Google. Try again.",
  "state-mismatch": "Security check failed. Try connecting again from this browser.",
  "state-invalid": "The connection link expired. Try again.",
  "user-mismatch": "Sign in as the user who started the connection.",
  "venue-not-found": "Venue not found.",
  "exchange-failed": "Google rejected the connection. Try again.",
};

type Connection = {
  externalAccountId: string | null;
  scopes: string;
  tokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
};

export function GoogleConnectionSection({
  venueId,
  configured,
  connection,
  flash,
}: {
  venueId: string;
  configured: boolean;
  connection: Connection | null;
  flash: string | null;
}) {
  const [state, formAction, pending] = useActionState(disconnectGoogle, initial);
  const flashLabel = flash ? (FLASH_LABELS[flash] ?? null) : null;

  return (
    <section className="flex max-w-xl flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold text-ink">Google Business Profile</h2>
        <p className="text-sm text-ash">
          Connect your Google Business Profile to pull reviews into TableKit and reply from one
          place. Phase 3a — pull/reply lands when the integration is approved by Google.
        </p>
      </header>

      {flashLabel ? (
        <p
          role={flash === "connected" || flash === "disconnected" ? "status" : "alert"}
          className={
            flash === "connected" || flash === "disconnected"
              ? "rounded-md bg-green-50 px-3 py-2 text-sm text-green-700"
              : "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          }
        >
          {flashLabel}
        </p>
      ) : null}

      {connection ? (
        <div className="flex flex-col gap-2 rounded-md border border-hairline bg-white p-4">
          <p className="text-sm font-medium text-ink">Connected</p>
          <dl className="grid grid-cols-2 gap-y-1 text-xs text-ash">
            <dt>Scopes</dt>
            <dd className="text-charcoal">{connection.scopes || "—"}</dd>
            <dt>Token expires</dt>
            <dd className="text-charcoal">
              {connection.tokenExpiresAt?.toLocaleString() ?? "—"}
            </dd>
            <dt>Last sync</dt>
            <dd className="text-charcoal">
              {connection.lastSyncedAt?.toLocaleString() ?? "Not yet — Phase 3b"}
            </dd>
          </dl>
          <form action={formAction} className="mt-1">
            <input type="hidden" name="venue_id" value={venueId} />
            {state.status === "error" ? (
              <p role="alert" className="mb-2 text-xs text-red-600">
                {state.message}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={pending}
              className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:border-ink disabled:opacity-50"
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </button>
          </form>
        </div>
      ) : configured ? (
        <a
          href={`/api/oauth/google/start?venueId=${venueId}`}
          className="inline-flex w-fit items-center justify-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-charcoal"
        >
          Connect Google Business Profile
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="inline-flex w-fit cursor-not-allowed items-center justify-center rounded-md border border-hairline bg-cloud px-4 py-2 text-sm text-ash"
        >
          Coming soon
        </button>
      )}
    </section>
  );
}
