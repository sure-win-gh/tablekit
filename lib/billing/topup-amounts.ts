// Top-up amount presets — pure constants, NO "server-only".
//
// Split out from lib/billing/topup.ts (which is server-only — it pulls in
// the Stripe client + adminDb) so the campaign composer (a Client Component)
// can import the preset list + guard without dragging server code into the
// browser bundle.

// Preset top-up amounts (pence). Server-validated — the action rejects
// anything not in this set.
export const TOPUP_AMOUNTS_PENCE = [1000, 2000, 5000] as const;
export type TopupAmount = (typeof TOPUP_AMOUNTS_PENCE)[number];

export function isTopupAmount(n: number): n is TopupAmount {
  return (TOPUP_AMOUNTS_PENCE as readonly number[]).includes(n);
}
