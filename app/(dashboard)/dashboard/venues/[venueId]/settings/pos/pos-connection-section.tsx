"use client";

import { useActionState } from "react";

import { disconnectPos, type PosActionState } from "./pos-actions";

const initial: PosActionState = { status: "idle" };

const PROVIDER_LABELS: Record<string, string> = {
  square: "Square",
  lightspeed_k: "Lightspeed (K-Series)",
  generic: "Generic / CSV",
};

const FLASH_LABELS: Record<string, string> = {
  connected: "Connected — order history will appear shortly.",
  disconnected: "Disconnected.",
  denied: "You denied access. Nothing was changed.",
  disabled: "This POS integration isn't enabled on this deployment.",
  "plus-required": "POS integrations are a Plus-tier feature.",
  "bad-request": "Couldn't read the response. Try again.",
  "state-mismatch": "Security check failed. Try connecting again from this browser.",
  "state-invalid": "The connection link expired. Try again.",
  "user-mismatch": "Sign in as the user who started the connection.",
  "venue-not-found": "Venue not found.",
  "exchange-failed": "The till rejected the connection. Try again.",
};

export type PosConnection = {
  id: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  lineItemsEnabled: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
};

export function PosConnectionSection({
  venueId,
  connections,
  squareConfigured,
  lightspeedConfigured,
  flash,
}: {
  venueId: string;
  connections: PosConnection[];
  squareConfigured: boolean;
  lightspeedConfigured: boolean;
  flash: string | null;
}) {
  const [state, formAction, pending] = useActionState(disconnectPos, initial);
  const flashLabel = flash ? (FLASH_LABELS[flash] ?? null) : null;

  const byProvider = new Map(connections.map((c) => [c.provider, c]));
  const active = (p: string) => byProvider.get(p)?.status === "active";

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header>
        <h2 className="text-ink text-base font-semibold">Till / POS</h2>
        <p className="text-ash text-sm">
          Connect your till to attach order history and spend to guest profiles. Read-only — we
          never touch card data.
        </p>
      </header>

      {flashLabel ? <p className="text-ash text-sm">{flashLabel}</p> : null}
      {state.status === "error" ? <p className="text-coral text-sm">{state.message}</p> : null}

      <ul className="flex flex-col gap-3">
        {(["square", "lightspeed_k", "generic"] as const).map((provider) => {
          const conn = byProvider.get(provider);
          const isActive = active(provider);
          const configured =
            provider === "square"
              ? squareConfigured
              : provider === "lightspeed_k"
                ? lightspeedConfigured
                : true;
          return (
            <li
              key={provider}
              className="border-cloud flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <p className="text-ink text-sm font-medium">{PROVIDER_LABELS[provider]}</p>
                <p className="text-ash text-xs">
                  {isActive
                    ? `Connected${conn?.lastSyncedAt ? ` · synced ${conn.lastSyncedAt.toLocaleDateString()}` : ""}`
                    : configured
                      ? "Not connected"
                      : "Not available on this deployment"}
                </p>
              </div>
              {isActive ? (
                <form action={formAction}>
                  <input type="hidden" name="venue_id" value={venueId} />
                  <input type="hidden" name="provider" value={provider} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="text-coral text-sm font-medium disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </form>
              ) : provider === "generic" ? (
                <span className="text-ash text-xs">Webhook / CSV</span>
              ) : configured ? (
                <a
                  href={`/api/oauth/${provider === "lightspeed_k" ? "lightspeed" : "square"}/start?venueId=${venueId}`}
                  className="bg-ink text-cloud rounded-md px-3 py-1.5 text-sm font-medium"
                >
                  Connect
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
