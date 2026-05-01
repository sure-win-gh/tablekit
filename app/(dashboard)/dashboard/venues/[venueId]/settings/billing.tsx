"use client";

import { useActionState } from "react";

import { startStripeOnboardingAction, type StartStripeOnboardingState } from "./actions";

type AccountSummary = {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

const FLASH_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  complete: {
    tone: "ok",
    text: "Stripe onboarding submitted. Charges will enable once Stripe finishes verification.",
  },
  refresh: {
    tone: "warn",
    text: "Stripe asked you to start again. Hit the button below to re-open onboarding.",
  },
  disabled: { tone: "warn", text: "Payments are currently disabled." },
  error: { tone: "warn", text: "Something went wrong talking to Stripe — try again in a minute." },
};

export function BillingSection({
  venueId,
  account,
  flash,
}: {
  venueId: string;
  account: AccountSummary | null;
  flash: string | null;
}) {
  const [state, formAction, pending] = useActionState<StartStripeOnboardingState, FormData>(
    async (prev, form) => {
      const r = await startStripeOnboardingAction(prev, form);
      if (r.status === "redirect") {
        // Server action returns the hosted Stripe URL — the client
        // pushes the redirect. Standard Next pattern.
        window.location.href = r.url;
      }
      return r;
    },
    { status: "idle" },
  );

  const flashMsg = flash ? FLASH_MESSAGES[flash] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-ink text-lg font-medium tracking-tight">Payments</h2>
        <p className="text-ash text-sm">
          Connect a Stripe account to collect deposits and hold cards for no-show protection. We use
          Stripe Connect Standard — you&apos;re the merchant of record.
        </p>
      </div>

      {flashMsg ? (
        <div
          className={`rounded-md border p-3 text-sm ${
            flashMsg.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {flashMsg.text}
        </div>
      ) : null}

      {account ? (
        <StatusPanel account={account} />
      ) : (
        <p className="text-ash text-sm">No Stripe account connected yet.</p>
      )}

      <form action={formAction}>
        <input type="hidden" name="venueId" value={venueId} />
        <button
          type="submit"
          disabled={pending}
          className="bg-ink hover:bg-charcoal rounded-md px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
        >
          {pending ? "Preparing…" : account ? "Continue Stripe onboarding" : "Connect Stripe"}
        </button>
        {state.status === "error" ? (
          <span className="text-rose ml-3 text-sm">{state.message}</span>
        ) : null}
      </form>
    </div>
  );
}

function StatusPanel({ account }: { account: AccountSummary }) {
  return (
    <dl className="border-hairline rounded-md border p-4 text-sm">
      <Row label="Stripe account" value={<span className="font-mono">{account.accountId}</span>} />
      <Row label="Charges enabled" value={account.chargesEnabled ? "Yes" : "No"} />
      <Row label="Payouts enabled" value={account.payoutsEnabled ? "Yes" : "No"} />
      <Row label="Details submitted" value={account.detailsSubmitted ? "Yes" : "No"} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <dt className="text-ash">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
