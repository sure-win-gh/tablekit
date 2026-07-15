import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Webhooks · TableKit",
  description:
    "Have TableKit call your server the moment a booking changes — events, signature verification, and retries in plain English.",
};

// Plain-English webhooks guide. Content sourced from
// docs/specs/public-api.md and verified against lib/webhooks/
// (sign.ts, deliver.ts, events.ts) — the envelope, header, and retry
// numbers below are the implementation's, not aspirational.

function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-card border-hairline bg-cloud overflow-x-auto border p-4 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

export default function DocsWebhooks() {
  return (
    <article className="text-charcoal flex max-w-3xl flex-col gap-8 text-sm leading-relaxed">
      <section className="flex flex-col gap-3">
        <h1 className="text-ink text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p>
          Instead of your software repeatedly asking &quot;any new bookings?&quot;, webhooks turn it
          around: TableKit calls <em>your</em> server the moment something happens. You give us a
          URL; we send it a small JSON message on every event you subscribe to.
        </p>
        <p className="text-ash">
          Set them up in the dashboard under{" "}
          <span className="font-mono text-xs">Organisation → Webhooks</span> (Plus plan, like the
          rest of the API). You&apos;ll get a signing secret at registration — shown once, same as
          API keys.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">The five events</h2>
        <div className="rounded-card border-hairline overflow-hidden border">
          <table className="w-full text-sm">
            <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
              <tr>
                <th className="px-4 py-2.5">Event</th>
                <th className="px-4 py-2.5">Sent when…</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y">
              <tr>
                <td className="px-4 py-3 font-mono text-xs">booking.created</td>
                <td className="px-4 py-3">a new booking is made (widget, dashboard, or API)</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">booking.updated</td>
                <td className="px-4 py-3">a booking is rescheduled or its details change</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">booking.cancelled</td>
                <td className="px-4 py-3">a booking is cancelled by the guest or your team</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">booking.seated</td>
                <td className="px-4 py-3">your team marks the party as arrived and seated</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">booking.no_show</td>
                <td className="px-4 py-3">your team marks the booking as a no-show</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>Every message has the same envelope:</p>
        <Code>{`{
  "id": "…",                       // unique per event — use it to ignore duplicates
  "type": "booking.created",
  "created_at": "2026-07-15T18:03:12.000Z",
  "data": { …the booking… }
}`}</Code>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">
          Check the message really came from us
        </h2>
        <p>
          Anyone who discovers your URL could POST fake JSON at it. That&apos;s why every delivery
          carries a signature header:
        </p>
        <Code>{`X-TableKit-Signature: sha256=2f6c1a…`}</Code>
        <p>
          To verify it, compute an HMAC-SHA256 of the request body using your signing secret and
          compare. In Node.js:
        </p>
        <Code>{`import { createHmac, timingSafeEqual } from "node:crypto";

export function isFromTableKit(rawBody, signatureHeader, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}`}</Code>
        <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
          One trap: verify against the <strong>raw bytes</strong> of the request body, before any
          JSON parsing. If you parse and re-stringify first, the whitespace and key order can change
          and the signature won&apos;t match even though the message is genuine.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">
          Retries — what happens if your server is down
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            Reply with any <span className="font-mono text-xs">2xx</span> status quickly —
            that&apos;s all we need. Do slow work after responding, not before.
          </li>
          <li>
            If we get an error or no answer, we retry: <strong>5 attempts</strong> in total, with
            growing gaps, spread over roughly 24 hours.
          </li>
          <li>
            After the fifth failure the delivery is marked failed. Every delivery — including
            failures — is listed in the dashboard with a <strong>replay</strong> button, so nothing
            is silently lost.
          </li>
          <li>
            Retries mean you can occasionally receive the same event twice. Keep the envelope{" "}
            <span className="font-mono text-xs">id</span> of messages you&apos;ve processed and skip
            repeats.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">Next</h2>
        <p>
          <Link href="/docs/errors" className="text-ink underline underline-offset-2">
            Errors &amp; limits
          </Link>{" "}
          covers what API error responses look like and the request limits that apply to your key.
        </p>
      </section>
    </article>
  );
}
