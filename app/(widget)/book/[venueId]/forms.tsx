"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

type SlotLite = { serviceId: string; serviceName: string; wallStart: string };

// ---------------------------------------------------------------------------
// Date + party + slot grid — URL driven.
// ---------------------------------------------------------------------------

export function SlotPicker({
  venueId,
  date,
  partySize,
  slots,
  picked,
}: {
  venueId: string;
  date: string;
  partySize: number;
  slots: SlotLite[];
  picked: { serviceId: string; wallStart: string } | null;
}) {
  const router = useRouter();

  function navigate(
    patch: Partial<{ date: string; party: number; serviceId: string; wallStart: string }>,
  ) {
    const sp = new URLSearchParams();
    sp.set("date", patch.date ?? date);
    sp.set("party", String(patch.party ?? partySize));
    if (patch.serviceId) sp.set("serviceId", patch.serviceId);
    if (patch.wallStart) sp.set("wallStart", patch.wallStart);
    router.push(`/book/${venueId}?${sp.toString()}`);
  }

  const byService = new Map<string, SlotLite[]>();
  for (const s of slots) {
    const list = byService.get(s.serviceName) ?? [];
    list.push(s);
    byService.set(s.serviceName, list);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => navigate({ date: e.target.value })}
            className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-700">Party size</span>
          <input
            type="number"
            min={1}
            max={20}
            value={partySize}
            onChange={(e) => navigate({ party: Number(e.target.value) })}
            className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
          />
        </label>
      </div>

      {slots.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          Sorry, nothing available at that date and party size. Try another date or a smaller party.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...byService.entries()].map(([svcName, list]) => (
            <div key={svcName}>
              <h3 className="text-sm font-semibold tracking-tight text-neutral-700">{svcName}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {list.map((s) => {
                  const isPicked =
                    picked?.serviceId === s.serviceId && picked?.wallStart === s.wallStart;
                  return (
                    <button
                      key={`${s.serviceId}-${s.wallStart}`}
                      type="button"
                      onClick={() => navigate({ serviceId: s.serviceId, wallStart: s.wallStart })}
                      className={`rounded-md border px-3 py-1.5 text-sm font-medium tabular-nums transition ${
                        isPicked
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
                      }`}
                    >
                      {s.wallStart}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

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
}: {
  venueId: string;
  serviceId: string;
  date: string;
  wallStart: string;
  partySize: number;
  captchaSitekey: string | null;
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
      <section className="flex flex-col gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-6 text-emerald-900">
        <h2 className="text-lg font-semibold">You&apos;re booked.</h2>
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
      className="flex flex-col gap-4 rounded-md border border-neutral-200 p-6"
    >
      <header>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Your details</h2>
        <p className="text-sm text-neutral-500">
          {wallStart} on {date} · party of {partySize}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" name="firstName" required autoComplete="given-name" />
        <Field label="Last name" name="lastName" autoComplete="family-name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Field label="Phone (optional)" name="phone" type="tel" autoComplete="tel" />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-700">Notes (optional)</span>
        <textarea
          name="notes"
          maxLength={500}
          rows={2}
          placeholder="Allergies, pushchair, etc."
          className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
        />
      </label>

      {captchaSitekey ? (
        <HCaptchaWidget sitekey={captchaSitekey} onVerify={setCaptchaToken} />
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {state.status === "error" ? (
          <span className="text-sm text-rose-600">{state.message}</span>
        ) : null}
        <button
          type="submit"
          disabled={state.status === "submitting"}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {state.status === "submitting" ? "Booking…" : "Confirm booking"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-700">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        autoComplete={autoComplete}
        className="rounded-md border border-neutral-300 px-2 py-1 text-neutral-900"
      />
    </label>
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
  return (
    <section className="flex flex-col gap-4 rounded-md border border-neutral-200 p-6">
      <header>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          {isHold ? "Card required" : "Deposit required"}
        </h2>
        <p className="text-sm text-neutral-500">
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
          appearance: { theme: "stripe" },
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
      {state.status === "error" ? <p className="text-sm text-rose-600">{state.message}</p> : null}
      <button
        type="submit"
        disabled={!stripe || state.status === "confirming"}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
      >
        {state.status === "confirming" ? "Processing…" : isHold ? "Save card" : "Pay deposit"}
      </button>
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
