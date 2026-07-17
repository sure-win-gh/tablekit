"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui";

export type CheckoutTicketType = {
  id: string;
  name: string;
  priceMinor: number;
  maxPerOrder: number;
  remaining: number;
};

function gbp(minor: number): string {
  const pounds = (minor / 100).toFixed(2).replace(/\.00$/, "");
  return `£${pounds}`;
}

// Stripe.js must be initialised with the connected account (Connect Standard
// direct charges live on acct_*). Cached per account. Mirrors the widget's
// deposit step.
const stripePromises = new Map<string, Promise<Stripe | null>>();
function getStripe(stripeAccount: string): Promise<Stripe | null> {
  const cached = stripePromises.get(stripeAccount);
  if (cached) return cached;
  const pk = process.env["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"];
  if (!pk || pk.includes("YOUR_")) return Promise.resolve(null);
  const promise = loadStripe(pk, { stripeAccount });
  stripePromises.set(stripeAccount, promise);
  return promise;
}

function errorMessage(code: unknown): string {
  switch (code) {
    case "sold-out":
      return "Sorry — those tickets just sold out.";
    case "event-not-on-sale":
      return "Tickets for this event aren't on sale.";
    case "payments-unavailable":
      return "Ticket sales are temporarily unavailable. Please try again later.";
    case "invalid-items":
      return "Check your ticket selection and try again.";
    case "guest-invalid":
      return "Please check your name and email.";
    case "rate-limited":
      return "Too many attempts — please wait a moment and try again.";
    case "captcha-failed":
      return "Couldn't verify you're human. Reload and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

type PurchaseState =
  | { status: "picking" }
  | { status: "submitting" }
  | { status: "error"; message: string }
  | { status: "paying"; clientSecret: string; stripeAccount: string; amountMinor: number }
  | { status: "done" };

export function EventCheckout({
  eventId,
  venueName,
  ticketTypes,
  captchaSitekey,
}: {
  eventId: string;
  venueName: string;
  ticketTypes: CheckoutTicketType[];
  captchaSitekey: string | null;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [state, setState] = useState<PurchaseState>({ status: "picking" });

  const selected = ticketTypes.map((t) => ({ t, q: qty[t.id] ?? 0 })).filter((x) => x.q > 0);
  const total = selected.reduce((n, x) => n + x.t.priceMinor * x.q, 0);
  const totalTickets = selected.reduce((n, x) => n + x.q, 0);

  function setQuantity(id: string, next: number, max: number) {
    setQty((prev) => ({ ...prev, [id]: Math.max(0, Math.min(max, next)) }));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selected.length === 0) return;
    const fd = new FormData(e.currentTarget);
    const guest = {
      firstName: String(fd.get("firstName") ?? ""),
      lastName: String(fd.get("lastName") ?? ""),
      email: String(fd.get("email") ?? ""),
      phone: (fd.get("phone") as string) || undefined,
    };
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/v1/events/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId,
          items: selected.map((x) => ({ ticketTypeId: x.t.id, quantity: x.q })),
          guest,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });
      const body: {
        ok?: boolean;
        error?: string;
        amountMinor?: number;
        deposit?: { clientSecret?: string; stripeAccount?: string };
      } = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok || !body.deposit?.clientSecret || !body.deposit.stripeAccount) {
        setState({ status: "error", message: errorMessage(body.error) });
        return;
      }
      setState({
        status: "paying",
        clientSecret: body.deposit.clientSecret,
        stripeAccount: body.deposit.stripeAccount,
        amountMinor: body.amountMinor ?? total,
      });
    } catch {
      setState({ status: "error", message: "Something went wrong. Please try again." });
    }
  }

  if (state.status === "done") {
    return (
      <div className="border-hairline rounded-card border bg-white p-6 text-center">
        <p className="text-ink text-lg font-bold tracking-tight">You&rsquo;re going! 🎉</p>
        <p className="text-charcoal mt-1 text-sm">
          Your tickets to {venueName} are confirmed — check your email for the details.
        </p>
      </div>
    );
  }

  if (state.status === "paying") {
    return (
      <PayStep
        clientSecret={state.clientSecret}
        stripeAccount={state.stripeAccount}
        amountMinor={state.amountMinor}
        onPaid={() => setState({ status: "done" })}
      />
    );
  }

  const submitting = state.status === "submitting";
  const allSoldOut = ticketTypes.every((t) => t.remaining <= 0);

  return (
    <form
      onSubmit={submit}
      className="border-hairline rounded-card flex flex-col gap-5 border bg-white p-5"
    >
      <div className="flex flex-col gap-3">
        {ticketTypes.map((t) => {
          const max = Math.min(t.remaining, t.maxPerOrder);
          const q = qty[t.id] ?? 0;
          const soldOut = t.remaining <= 0;
          return (
            <div key={t.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-ink truncate text-sm font-semibold">
                  {t.name} <span className="text-ash font-normal">· {gbp(t.priceMinor)}</span>
                </p>
                <p className="text-ash text-[11px]">
                  {soldOut ? "Sold out" : `${t.remaining} left`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`Remove one ${t.name}`}
                  disabled={q <= 0 || soldOut}
                  onClick={() => setQuantity(t.id, q - 1, max)}
                  className="border-hairline text-ink rounded-input h-8 w-8 border disabled:opacity-30"
                >
                  −
                </button>
                <span className="text-ink w-6 text-center text-sm tabular-nums">{q}</span>
                <button
                  type="button"
                  aria-label={`Add one ${t.name}`}
                  disabled={q >= max || soldOut}
                  onClick={() => setQuantity(t.id, q + 1, max)}
                  className="border-hairline text-ink rounded-input h-8 w-8 border disabled:opacity-30"
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {allSoldOut ? (
        <p className="text-ash text-center text-sm">This event is sold out.</p>
      ) : (
        <>
          <div className="border-hairline flex flex-col gap-3 border-t pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">First name</span>
                <input
                  name="firstName"
                  required
                  autoComplete="given-name"
                  className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">Last name</span>
                <input
                  name="lastName"
                  autoComplete="family-name"
                  className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">Email</span>
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">
                  Phone <span className="text-ash">(optional)</span>
                </span>
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  className="border-hairline text-ink rounded-input border px-3 py-2 text-sm"
                />
              </label>
            </div>

            <p className="text-ash text-xs">
              Your details go to the venue to manage your tickets and send your confirmation —
              nothing else. See our{" "}
              <a href="/privacy" className="underline">
                privacy notice
              </a>
              .
            </p>

            {captchaSitekey ? (
              <HCaptchaWidget sitekey={captchaSitekey} onVerify={setCaptchaToken} />
            ) : null}
          </div>

          {state.status === "error" ? (
            <p role="alert" className="text-rose text-sm">
              {state.message}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <span className="text-ink text-sm font-semibold tabular-nums">
              {totalTickets > 0
                ? `${totalTickets} ticket${totalTickets === 1 ? "" : "s"} · ${gbp(total)}`
                : "Select tickets"}
            </span>
            <Button type="submit" disabled={submitting || totalTickets === 0}>
              {submitting ? "Processing…" : "Continue to payment"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

// Payment step — reuses the widget's Connect-aware Payment Element pattern.
function PayStep({
  clientSecret,
  stripeAccount,
  amountMinor,
  onPaid,
}: {
  clientSecret: string;
  stripeAccount: string;
  amountMinor: number;
  onPaid: () => void;
}) {
  const stripe = useMemo(() => getStripe(stripeAccount), [stripeAccount]);
  return (
    <div className="border-hairline rounded-card flex flex-col gap-4 border bg-white p-5">
      <header>
        <h3 className="text-ink text-lg font-bold tracking-tight">Payment</h3>
        <p className="text-ash text-sm">{gbp(amountMinor)} — paid securely to the venue.</p>
      </header>
      <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: "stripe" } }}>
        <PaymentForm onPaid={onPaid} />
      </Elements>
    </div>
  );
}

function PaymentForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [state, setState] = useState<
    { status: "idle" } | { status: "confirming" } | { status: "error"; message: string }
  >({ status: "idle" });

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setState({ status: "confirming" });
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (result.error) {
      setState({ status: "error", message: result.error.message ?? "Payment failed. Try again." });
      return;
    }
    if (result.paymentIntent?.status === "succeeded") {
      onPaid();
      return;
    }
    setState({ status: "error", message: "Payment didn't complete. Please try again." });
  }

  return (
    <form onSubmit={pay} className="flex flex-col gap-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {state.status === "error" ? <p className="text-rose text-sm">{state.message}</p> : null}
      <Button type="submit" disabled={!stripe || state.status === "confirming"}>
        {state.status === "confirming" ? "Processing…" : "Pay now"}
      </Button>
    </form>
  );
}

// Minimal hCaptcha loader — same pattern as the booking widget.
function HCaptchaWidget({
  sitekey,
  onVerify,
}: {
  sitekey: string;
  onVerify: (token: string) => void;
}) {
  useEffect(() => {
    const handler = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      if (typeof token === "string") onVerify(token);
    };
    window.addEventListener("hcaptcha:verify", handler);
    (window as unknown as { onHcaptchaVerify?: (t: string) => void }).onHcaptchaVerify = (t) => {
      window.dispatchEvent(new CustomEvent("hcaptcha:verify", { detail: t }));
    };
    const existing = document.getElementById("hcaptcha-script");
    if (!existing) {
      const s = document.createElement("script");
      s.id = "hcaptcha-script";
      s.src = "https://hcaptcha.com/1/api.js";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    return () => window.removeEventListener("hcaptcha:verify", handler);
  }, [onVerify]);

  return <div className="h-captcha" data-sitekey={sitekey} data-callback="onHcaptchaVerify" />;
}
