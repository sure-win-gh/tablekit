import Link from "next/link";

export const metadata = { title: "Privacy · TableKit" };

// Public privacy notice. The legal heavy lifting (controller/processor
// distinction, lawful bases, retention) lives in the operational
// playbook — this page is the guest-facing summary in plain English,
// with a path to the request form for actioning rights.

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-coral">Trust</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Privacy notice</h1>
        <p className="mt-1.5 text-sm text-ash">
          A plain-English summary of how we handle personal data. The venue you book with is the
          data controller; we&apos;re the data processor working on their behalf.
        </p>
      </header>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">What we store</h2>
        <p>When you book a table through a TableKit-powered venue, we store:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>Your first and last name, email address, and phone number.</li>
          <li>The booking itself: date, time, party size, any notes you added.</li>
          <li>Booking history at that venue (so the venue can recognise repeat guests).</li>
          <li>Marketing-consent timestamps, if you opt in to receive future communication from the venue.</li>
        </ul>
        <p>
          Your last name, email and phone are encrypted at the column level. We never store your
          card details — those go directly to Stripe.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Why we store it</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <strong>Booking your table</strong> — we can&apos;t hold a reservation without contact
            details. (Lawful basis: contract.)
          </li>
          <li>
            <strong>Marketing</strong> — only if you&apos;ve opted in, per channel, per venue.
            (Lawful basis: consent.)
          </li>
          <li>
            <strong>Fraud prevention and abuse monitoring</strong> — limited, documented use.
            (Lawful basis: legitimate interests.)
          </li>
          <li>
            <strong>Accounting and legal retention</strong> — UK accounting rules require us to keep
            booking and payment records for seven years. (Lawful basis: legal obligation.)
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Where it lives</h2>
        <p>
          UK and EU only. Our database, hosting, payment provider, email and SMS providers are all
          configured with EU/UK residency. The full list and what each provider does is at{" "}
          <Link
            href="/legal/sub-processors"
            className="font-semibold text-ink underline underline-offset-4 hover:text-coral"
          >
            /legal/sub-processors
          </Link>
          .
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Your rights</h2>
        <p>
          Under UK GDPR you can ask the venue you booked with to provide a copy of the data they
          hold about you, correct it, or erase it. Use the request form linked from the venue&apos;s
          confirmation email, or fill it in here:
        </p>
        <p>
          <Link
            href="/privacy/request"
            className="inline-flex rounded-pill border border-hairline bg-white px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-ink"
          >
            Submit a privacy request
          </Link>
        </p>
        <p>
          Requests are routed to the venue. They&apos;ll respond within one calendar month. You can
          also complain to the UK Information Commissioner&apos;s Office (ICO) at any time.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Cookies</h2>
        <p>
          We use a single first-party session cookie on the operator dashboard for sign-in. The
          public booking widget and marketing site don&apos;t set tracking cookies. We don&apos;t
          run third-party analytics that fingerprint visitors.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Contact</h2>
        <p>
          For privacy questions:{" "}
          <Link
            href="mailto:privacy@tablekit.uk"
            className="font-semibold text-ink underline underline-offset-4 hover:text-coral"
          >
            privacy@tablekit.uk
          </Link>
          . For security:{" "}
          <Link
            href="mailto:security@tablekit.uk"
            className="font-semibold text-ink underline underline-offset-4 hover:text-coral"
          >
            security@tablekit.uk
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
