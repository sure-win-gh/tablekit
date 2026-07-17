"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button, Field, Input, Textarea } from "@/components/ui";

// The date/party/time pickers now live in steps.tsx (the wizard). This file
// keeps the Details step: the guest form, the Stripe deposit step, and the
// confirmation/success states.

// ---------------------------------------------------------------------------
// Guest form. POSTs to /api/v1/bookings. Captcha widget injected via
// iframe when the site key is configured; when not, the form submits
// without a token and the server-side helper passes through.
// ---------------------------------------------------------------------------

type DepositHandoff = {
  bookingId: string;
  reference: string;
  clientSecret: string;
  amountMinor: number;
  stripeAccount: string;
  // 'payment_intent' = flow A (charged at booking)
  // 'setup_intent'   = flow B (card stored, captured only on no-show)
  kind: "payment_intent" | "setup_intent";
};

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "deposit"; handoff: DepositHandoff }
  | {
      status: "success";
      reference: string;
      time: string;
      // 'none' = flow C (no payment step); 'payment_intent' = flow A
      // (deposit charged); 'setup_intent' = flow B (card on file).
      paymentKind: "none" | "payment_intent" | "setup_intent";
      amountMinor?: number;
    }
  | { status: "error"; message: string };

export function BookingForm({
  venueId,
  serviceId,
  date,
  wallStart,
  partySize,
  captchaSitekey,
  preferredAreaId,
}: {
  venueId: string;
  serviceId: string;
  date: string;
  wallStart: string;
  partySize: number;
  captchaSitekey: string | null;
  // Guest area preference — threaded from the ?area wizard param; a
  // guarantee server-side (docs/specs/area-preferences.md).
  preferredAreaId?: string | null;
}) {
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const [captchaToken, setCaptchaToken] = useState<string>("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ status: "submitting" });
    const form = new FormData(e.currentTarget);

    const payload = {
      venueId,
      serviceId,
      date,
      wallStart,
      partySize,
      notes: (form.get("notes") as string) || undefined,
      preferredAreaId: preferredAreaId || undefined,
      captchaToken: captchaToken || undefined,
      guest: {
        firstName: form.get("firstName"),
        lastName: form.get("lastName") || "",
        email: form.get("email"),
        phone: (form.get("phone") as string) || undefined,
      },
    };

    try {
      const res = await fetch("/api/v1/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as
        | {
            ok: true;
            bookingId: string;
            reference: string;
            status: "confirmed" | "requested";
            deposit?: {
              kind: "payment_intent" | "setup_intent";
              clientSecret: string;
              amountMinor: number;
              stripeAccount: string;
            };
          }
        | { error: string; issues?: string[] };
      if ("ok" in body && body.ok) {
        if (body.deposit) {
          setState({
            status: "deposit",
            handoff: {
              bookingId: body.bookingId,
              reference: body.reference,
              clientSecret: body.deposit.clientSecret,
              amountMinor: body.deposit.amountMinor,
              stripeAccount: body.deposit.stripeAccount,
              kind: body.deposit.kind,
            },
          });
          return;
        }
        setState({
          status: "success",
          reference: body.reference,
          time: wallStart,
          paymentKind: "none",
        });
        return;
      }
      const message =
        "issues" in body && body.issues
          ? body.issues.join("; ")
          : errorMessage(("error" in body && body.error) || "unknown");
      setState({ status: "error", message });
    } catch {
      setState({ status: "error", message: "Couldn't reach the server. Try again." });
    }
  }

  if (state.status === "deposit") {
    return (
      <DepositStep
        handoff={state.handoff}
        date={date}
        time={wallStart}
        onPaid={() =>
          setState({
            status: "success",
            reference: state.handoff.reference,
            time: wallStart,
            paymentKind: state.handoff.kind,
            amountMinor: state.handoff.amountMinor,
          })
        }
      />
    );
  }

  if (state.status === "success") {
    return (
      <section className="rounded-card flex flex-col gap-3 border border-emerald-300 bg-emerald-50 p-6 text-emerald-900">
        <h2 className="text-lg font-bold tracking-tight">You&apos;re booked.</h2>
        <p className="text-sm">
          Your reference is <span className="font-mono font-semibold">{state.reference}</span>.
          We&apos;ve got you down for {state.time} on {date}, party of {partySize}.
        </p>
        {state.paymentKind === "payment_intent" ? (
          <p className="text-sm">
            Your deposit was taken — it&apos;ll be applied to your bill on the night.
          </p>
        ) : null}
        {state.paymentKind === "setup_intent" ? (
          <p className="text-sm">
            Your card is on file. We won&apos;t charge it unless you don&apos;t turn up — in which
            case {state.amountMinor ? formatGbp(state.amountMinor) : "a no-show fee"} will be taken.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-card border-hairline shadow-panel flex flex-col gap-4 border bg-white p-6"
    >
      <header>
        <h2 className="text-ink text-lg font-bold tracking-tight">Your details</h2>
        <p className="text-ash text-sm">
          {wallStart} on {date} · party of {partySize}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="bk-fn">
          <Input id="bk-fn" name="firstName" required autoComplete="given-name" />
        </Field>
        <Field label="Last name" htmlFor="bk-ln" optional>
          <Input id="bk-ln" name="lastName" autoComplete="family-name" />
        </Field>
        <Field label="Email" htmlFor="bk-email">
          <Input id="bk-email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Phone" htmlFor="bk-phone" optional>
          <Input id="bk-phone" name="phone" type="tel" autoComplete="tel" />
        </Field>
      </div>

      <Field label="Notes" htmlFor="bk-notes" optional>
        <Textarea
          id="bk-notes"
          name="notes"
          maxLength={500}
          rows={2}
          placeholder="Allergies, pushchair, etc."
        />
      </Field>

      {captchaSitekey ? (
        <HCaptchaWidget sitekey={captchaSitekey} onVerify={setCaptchaToken} />
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-rose text-sm">{state.message}</span>
        ) : null}
        <Button type="submit" disabled={state.status === "submitting"}>
          {state.status === "submitting" ? "Booking…" : "Confirm booking"}
        </Button>
      </div>
    </form>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "rate-limited":
      return "Too many requests — slow down and try again in a few minutes.";
    case "captcha-failed":
      return "Couldn't verify the captcha. Try the widget again.";
    case "slot-taken":
      return "Someone else just took that time — please pick another.";
    case "no-availability":
      return "That time is no longer available.";
    case "venue-closed":
      return "This date is being held for a special event — check the venue's events for tickets.";
    case "venue-not-found":
      return "We can't find this venue any more.";
    case "invalid-input":
      return "Some fields are invalid — check and try again.";
    case "invalid-json":
      return "The request couldn't be read. Reload and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

// ---------------------------------------------------------------------------
// Deposit step — mounted when the API returns a `deposit.clientSecret`.
// We confirm the PaymentIntent client-side with Stripe Elements; 3DS
// challenges happen in-browser via Stripe's own UI. The
// payment_intent.succeeded webhook flips the booking to confirmed on
// the server side; this component just drives the client interaction
// and then moves the widget to the success screen.
// ---------------------------------------------------------------------------

// Module-level cache keyed by connected-account id. Connect Standard
// direct charges live on acct_*, so Stripe.js must be initialised with
// `stripeAccount` — otherwise the Payment Element load-errors trying
// to look up the Intent on the platform account.
const stripePromises: Map<string, Promise<Stripe | null>> = new Map();
function getStripe(stripeAccount: string): Promise<Stripe | null> {
  const cached = stripePromises.get(stripeAccount);
  if (cached) return cached;
  const pk = process.env["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"];
  if (!pk || pk.includes("YOUR_")) return Promise.resolve(null);
  const promise = loadStripe(pk, { stripeAccount });
  stripePromises.set(stripeAccount, promise);
  return promise;
}

function DepositStep({
  handoff,
  date,
  time,
  onPaid,
}: {
  handoff: DepositHandoff;
  date: string;
  time: string;
  onPaid: () => void;
}) {
  const stripe = useMemo(() => getStripe(handoff.stripeAccount), [handoff.stripeAccount]);
  const isHold = handoff.kind === "setup_intent";

  // Mirror the widget's accent + corner radius into the Stripe Payment
  // Element so the pay button matches the "Confirm booking" button above
  // it. We read the resolved CSS variables off this section (which sits in
  // the themed wrapper subtree, so it picks up any per-venue override)
  // rather than threading props through the booking state machine. Because
  // --color-coral is globally defined, this resolves to Tablekit coral for
  // Free/Core and the operator's colour for Plus — consistent on every
  // tier, never bare Stripe blue. Appearance value only, never injected
  // CSS — PCI SAQ-A is intact.
  const rootRef = useRef<HTMLElement>(null);
  const [appearanceVars, setAppearanceVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const accent = cs.getPropertyValue("--color-coral").trim();
    const radius = cs.getPropertyValue("--radius-input").trim();
    const vars: Record<string, string> = {};
    if (accent) vars["colorPrimary"] = accent;
    if (radius) vars["borderRadius"] = radius;
    setAppearanceVars(Object.keys(vars).length > 0 ? vars : null);
  }, []);

  return (
    <section
      ref={rootRef}
      className="rounded-card border-hairline shadow-panel flex flex-col gap-4 border bg-white p-6"
    >
      <header>
        <h2 className="text-ink text-lg font-bold tracking-tight">
          {isHold ? "Card required" : "Deposit required"}
        </h2>
        <p className="text-ash text-sm">
          {time} on {date} ·{" "}
          {isHold
            ? `we'll only charge ${formatGbp(handoff.amountMinor)} if you don't show up.`
            : `a ${formatGbp(handoff.amountMinor)} deposit secures the table. It's applied to your bill on the night.`}
        </p>
      </header>
      <Elements
        stripe={stripe}
        options={{
          clientSecret: handoff.clientSecret,
          appearance: appearanceVars
            ? { theme: "stripe", variables: appearanceVars }
            : { theme: "stripe" },
        }}
      >
        <DepositPaymentForm kind={handoff.kind} onPaid={onPaid} />
      </Elements>
    </section>
  );
}

function DepositPaymentForm({
  kind,
  onPaid,
}: {
  kind: "payment_intent" | "setup_intent";
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [state, setState] = useState<
    { status: "idle" } | { status: "confirming" } | { status: "error"; message: string }
  >({ status: "idle" });
  const isHold = kind === "setup_intent";

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setState({ status: "confirming" });

    // Redirect only if the card requires a 3DS hop Stripe can't do
    // inline. For cards that complete inline, `redirect: "if_required"`
    // resolves without navigating and we drive the UI ourselves.
    const confirmParams = { return_url: window.location.href };
    const result = isHold
      ? await stripe.confirmSetup({
          elements,
          confirmParams,
          redirect: "if_required",
        })
      : await stripe.confirmPayment({
          elements,
          confirmParams,
          redirect: "if_required",
        });

    if (result.error) {
      setState({
        status: "error",
        message: result.error.message ?? "Payment failed. Try again.",
      });
      return;
    }
    // confirmPayment returns { paymentIntent }; confirmSetup returns
    // { setupIntent }. Both have .status = 'succeeded' on success.
    const succeeded =
      ("paymentIntent" in result && result.paymentIntent?.status === "succeeded") ||
      ("setupIntent" in result && result.setupIntent?.status === "succeeded");
    if (succeeded) {
      onPaid();
      return;
    }
    setState({
      status: "error",
      message: isHold
        ? "Couldn't save your card. Please try again."
        : "Payment didn't complete. Please try again.",
    });
  }

  return (
    <form onSubmit={pay} className="flex flex-col gap-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {state.status === "error" ? <p className="text-rose text-sm">{state.message}</p> : null}
      <Button type="submit" disabled={!stripe || state.status === "confirming"}>
        {state.status === "confirming" ? "Processing…" : isHold ? "Save card" : "Pay deposit"}
      </Button>
    </form>
  );
}

function formatGbp(minor: number): string {
  const pounds = (minor / 100).toFixed(2).replace(/\.00$/, "");
  return `£${pounds}`;
}

// Minimal hCaptcha loader. The `h-captcha` div auto-renders once the
// script hits `window.hcaptcha`; we route its callback through a
// named global the script can see, which dispatches a custom event
// we listen for.
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
    // Inject the hCaptcha script once per page.
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
