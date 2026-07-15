import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "API getting started · TableKit",
  description:
    "Plain-English guide to the TableKit API: get a key, make your first request, and connect your website or till to your bookings.",
};

// Plain-English getting-started guide. Audience: a venue owner or the
// web developer they've hired — assume curiosity, not an API
// background. Every code block is copy-paste runnable.

function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-card border-hairline bg-cloud overflow-x-auto border p-4 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

export default function DocsGettingStarted() {
  return (
    <article className="prose-headings:text-ink text-charcoal flex max-w-3xl flex-col gap-8 text-sm leading-relaxed">
      <section className="flex flex-col gap-3">
        <h1 className="text-ink text-2xl font-semibold tracking-tight">
          Use TableKit from your own website or tools
        </h1>
        <p>
          The TableKit API lets your own software talk to your bookings. Anything you can see in the
          dashboard — bookings, guests, venues, services — your website, till system, or spreadsheet
          automation can read too, and it can create or change bookings that follow exactly the same
          availability rules as the dashboard.
        </p>
        <p className="text-ash">
          The API is included in the <strong>Plus</strong> plan. You don&apos;t need it to take
          bookings — the booking widget and hosted booking page work without any code. Reach for the
          API when you want to build something custom.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">1. Get your API key</h2>
        <p>
          Only the <strong>account owner</strong> can create API keys. In the dashboard, go to{" "}
          <span className="font-mono text-xs">Organisation → API keys</span>, give the key a name
          you&apos;ll recognise later (&quot;Website integration&quot;, &quot;Till sync&quot;), and
          create it.
        </p>
        <p>
          The key looks like <span className="font-mono text-xs">sk_live_…</span> and is shown{" "}
          <strong>once</strong>. Copy it somewhere safe — we only store a fingerprint, so we
          can&apos;t show it to you again. If you lose it (or it leaks), revoke it in the same
          screen and create a new one. Revocation takes effect immediately.
        </p>
        <p className="rounded-card border-hairline bg-cloud text-ash border p-3 text-xs">
          Treat the key like a password: it can read your guests&apos; contact details. Never put it
          in website code that runs in the browser — keep it on your server.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">2. Make your first request</h2>
        <p>
          Every request sends the key in the{" "}
          <span className="font-mono text-xs">Authorization</span> header. This one lists your
          venues — a good first test because it needs no other input:
        </p>
        <Code>{`curl https://api.tablekit.uk/v1/venues \\
  -H "Authorization: Bearer sk_live_YOUR_KEY_HERE"`}</Code>
        <p>
          You&apos;ll get JSON back with each venue&apos;s id and name. Keep a venue id handy — most
          other requests ask for one.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">3. Common tasks</h2>
        <p className="text-ink font-medium">See today&apos;s bookings</p>
        <Code>{`curl "https://api.tablekit.uk/v1/bookings?venue_id=VENUE_ID&from=2026-07-15&to=2026-07-15" \\
  -H "Authorization: Bearer sk_live_YOUR_KEY_HERE"`}</Code>

        <p className="text-ink font-medium">Check free tables before offering a time</p>
        <p>Availability is public (it powers the booking widget), so this request needs no key:</p>
        <Code>{`curl "https://api.tablekit.uk/v1/availability?venue_id=VENUE_ID&date=2026-07-20&party_size=4"`}</Code>

        <p className="text-ink font-medium">Create a booking</p>
        <Code>{`curl -X POST https://api.tablekit.uk/v1/bookings \\
  -H "Authorization: Bearer sk_live_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: a-unique-id-you-choose" \\
  -d '{
    "venueId": "VENUE_ID",
    "serviceId": "SERVICE_ID",
    "date": "2026-07-20",
    "wallStart": "19:00",
    "partySize": 4,
    "guest": { "firstName": "Jane", "lastName": "Doe", "email": "jane@example.com" }
  }'`}</Code>
        <p>
          The <span className="font-mono text-xs">Idempotency-Key</span> header is your safety net:
          if your request times out and you retry it with the same key, you get the same booking
          back instead of a duplicate. Any unique string works — an order id from your own system is
          perfect.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">Where to go next</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <Link href="/docs/api" className="text-ink underline underline-offset-2">
              API reference
            </Link>{" "}
            — every endpoint and field, with a &quot;try it&quot; panel you can use in the browser.
          </li>
          <li>
            <Link href="/docs/webhooks" className="text-ink underline underline-offset-2">
              Webhooks
            </Link>{" "}
            — instead of asking us for changes, have TableKit call your server the moment a booking
            is created, changed, or cancelled.
          </li>
          <li>
            <Link href="/docs/errors" className="text-ink underline underline-offset-2">
              Errors &amp; limits
            </Link>{" "}
            — what error responses look like and how many requests you can make.
          </li>
        </ul>
      </section>
    </article>
  );
}
