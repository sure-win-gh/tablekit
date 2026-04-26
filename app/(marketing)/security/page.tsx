import Link from "next/link";

export const metadata = { title: "Security · TableKit" };

// Public security policy + vulnerability disclosure. Pairs with
// /.well-known/security.txt (RFC 9116). Content lifted from
// docs/playbooks/security.md — the public surface, not the full
// internal threat model.

export default function SecurityPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-coral">Trust</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Security</h1>
        <p className="mt-1.5 text-sm text-ash">
          How we protect operator and guest data, and how to report a vulnerability if you find one.
        </p>
      </header>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Baseline controls</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            Postgres row-level security on every table containing organisation data — verified by
            integration tests on every release.
          </li>
          <li>Column-level envelope encryption (AES-256-GCM) for guest PII (last name, email, phone).</li>
          <li>TLS 1.3 + HSTS preload everywhere; HTTPS-only.</li>
          <li>Strict Content Security Policy on the dashboard; widget origins validated against an allowlist.</li>
          <li>Rate limiting and hCaptcha on the public booking endpoint.</li>
          <li>
            Webhook signature verification (Stripe, Twilio, Resend) on every inbound call. Failed
            verifications return 400.
          </li>
          <li>
            EU/UK data residency. Sub-processors documented at{" "}
            <Link href="/legal/sub-processors" className="font-semibold text-ink underline underline-offset-4 hover:text-coral">/legal/sub-processors</Link>.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Reporting a vulnerability</h2>
        <p>
          We welcome reports from the security community. Please email{" "}
          <Link
            href="mailto:security@tablekit.uk"
            className="font-semibold text-ink underline underline-offset-4 hover:text-coral"
          >
            security@tablekit.uk
          </Link>{" "}
          with a clear description and reproduction steps. PGP key and machine-readable contact data
          are at{" "}
          <Link
            href="/.well-known/security.txt"
            className="font-mono text-xs font-semibold text-ink underline underline-offset-4 hover:text-coral"
          >
            /.well-known/security.txt
          </Link>
          .
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Scope</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>
            <span className="font-mono text-xs">tablekit.uk</span>,{" "}
            <span className="font-mono text-xs">app.tablekit.uk</span>,{" "}
            <span className="font-mono text-xs">book.tablekit.uk</span>,{" "}
            <span className="font-mono text-xs">api.tablekit.uk</span>.
          </li>
          <li>The booking widget when embedded on third-party sites.</li>
        </ul>
        <p>
          Out of scope: third-party services (Stripe, Resend, Twilio etc — please report to the
          relevant vendor), volumetric DoS, social engineering of staff, physical attacks.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Safe harbour</h2>
        <p>
          We will not pursue legal action against good-faith researchers who: avoid privacy
          violations, destruction of data, or interruption to our service; do not extract or modify
          data beyond what&apos;s necessary to demonstrate the issue; give us reasonable time to
          remediate before any public disclosure.
        </p>
      </section>

      <section className="flex flex-col gap-3 text-sm leading-relaxed text-charcoal">
        <h2 className="text-lg font-bold tracking-tight text-ink">Response targets</h2>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>Triage acknowledgement within 7 days.</li>
          <li>Critical issues remediated within 30 days; lower-severity issues prioritised on the next sprint.</li>
        </ul>
        <p>
          We don&apos;t run a paid bug bounty yet. Confirmed reports are publicly credited (with
          your permission) once the issue is fixed.
        </p>
      </section>
    </main>
  );
}
