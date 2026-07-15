import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Errors & limits · TableKit",
  description:
    "What TableKit API errors look like, what each code means, and the request limits that apply to your key.",
};

// Plain-English errors + limits page. Codes and statuses mirror
// lib/api/v1/responses.ts (the single error factory) — if a code is
// added there, add a row here.

function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-card border-hairline bg-cloud overflow-x-auto border p-4 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

const ERROR_ROWS = [
  {
    code: "unauthorized",
    status: "401",
    means: "The API key is missing, wrong, or has been revoked.",
    fix: "Check the Authorization header. If the key was revoked, create a new one in the dashboard.",
  },
  {
    code: "bad_request",
    status: "400",
    means:
      "Something about the request itself is wrong — a missing field, a bad id, a date in the wrong format.",
    fix: "The message says which part. Fix the request; retrying unchanged will fail the same way.",
  },
  {
    code: "not_found",
    status: "404",
    means:
      "No such thing — or it belongs to a different organisation. We answer both the same way on purpose.",
    fix: "Check the id, and that the key belongs to the right organisation.",
  },
  {
    code: "conflict",
    status: "409",
    means: "Your earlier request with the same Idempotency-Key is still being processed.",
    fix: "Wait a moment and retry with the same key — you'll get the original result.",
  },
  {
    code: "rate_limited",
    status: "429",
    means: "Too many requests in the last minute.",
    fix: "Wait the number of seconds in the Retry-After header, then continue.",
  },
  {
    code: "internal_error",
    status: "500",
    means: "Something went wrong on our side. The details are in our logs, never in the response.",
    fix: "Safe to retry. If it persists, contact support with the time it happened.",
  },
] as const;

export default function DocsErrors() {
  return (
    <article className="text-charcoal flex max-w-3xl flex-col gap-8 text-sm leading-relaxed">
      <section className="flex flex-col gap-3">
        <h1 className="text-ink text-2xl font-semibold tracking-tight">Errors &amp; limits</h1>
        <p>
          Every error the API returns has the same shape, so your code only needs one error handler:
        </p>
        <Code>{`{
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exceeded. Retry after 60s."
  }
}`}</Code>
        <p>
          Branch on <span className="font-mono text-xs">error.code</span> — the codes are stable and
          will never change meaning. The <span className="font-mono text-xs">message</span> is for
          humans reading logs and may be reworded over time.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">The six error codes</h2>
        <div className="rounded-card border-hairline overflow-hidden border">
          <table className="w-full text-sm">
            <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
              <tr>
                <th className="px-4 py-2.5">Code</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">What it means</th>
                <th className="px-4 py-2.5">What to do</th>
              </tr>
            </thead>
            <tbody className="divide-hairline divide-y align-top">
              {ERROR_ROWS.map((r) => (
                <tr key={r.code}>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{r.code}</td>
                  <td className="px-4 py-3">{r.status}</td>
                  <td className="px-4 py-3">{r.means}</td>
                  <td className="px-4 py-3">{r.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">Request limits</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <strong>600 requests per minute per key</strong> — about 10 per second, plenty for a
            website plus a till sync. Two keys in the same organisation each get their own
            allowance, so use one key per integration.
          </li>
          <li>
            Go over it and you&apos;ll get <span className="font-mono text-xs">429</span> responses
            with a <span className="font-mono text-xs">Retry-After</span> header saying how many
            seconds to wait. Well-behaved code waits, then carries on — no harm done.
          </li>
          <li>
            Request bodies are capped at <strong>32&nbsp;KB</strong>. A booking request is well
            under 1&nbsp;KB, so this only matters if something is wrong.
          </li>
          <li>
            The public availability endpoint (no key) is limited per visitor instead — 30 requests a
            minute, which a real person browsing dates never reaches.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-ink text-lg font-medium tracking-tight">Next</h2>
        <p>
          The{" "}
          <Link href="/docs/api" className="text-ink underline underline-offset-2">
            API reference
          </Link>{" "}
          lists which of these errors each endpoint can return, per response code.
        </p>
      </section>
    </article>
  );
}
