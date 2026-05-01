import Link from "next/link";

export const metadata = { title: "Sub-processors · TableKit" };

// Mirrors the table in docs/playbooks/gdpr.md. Update both at the
// same time when adding or removing a sub-processor — the playbook
// is the operational source of truth, this page is the public
// surface customers see.

type Row = {
  name: string;
  purpose: string;
  region: string;
  dpa: string;
};

const ROWS: Row[] = [
  {
    name: "Supabase",
    purpose: "Database, auth, storage",
    region: "EU (Frankfurt or London)",
    dpa: "Signed",
  },
  {
    name: "Vercel",
    purpose: "Application hosting, edge",
    region: "EU regions only",
    dpa: "Signed",
  },
  { name: "Stripe", purpose: "Payments + Connect", region: "EU (Ireland)", dpa: "Signed" },
  { name: "Resend", purpose: "Transactional email", region: "EU", dpa: "Signed" },
  { name: "Twilio", purpose: "SMS", region: "EU (Ireland)", dpa: "Signed" },
  { name: "Sentry", purpose: "Error tracking", region: "EU", dpa: "Signed" },
  {
    name: "Cloudflare",
    purpose: "DNS, WAF, edge cache (no PII routed)",
    region: "Global",
    dpa: "Signed",
  },
];

const LAST_UPDATED = "2026-04-26";

export default function SubProcessorsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <header>
        <p className="text-coral text-xs font-semibold tracking-wider uppercase">Legal</p>
        <h1 className="text-ink mt-2 text-3xl font-bold tracking-tight">Sub-processors</h1>
        <p className="text-ash mt-1.5 text-sm">
          Third parties we engage to deliver TableKit on behalf of customer organisations. Each has
          a signed Data Processing Agreement (DPA) and processes personal data only on documented
          instructions. We notify customers at least <strong>30 days</strong> before adding any new
          sub-processor.
        </p>
      </header>

      <div className="rounded-card border-hairline overflow-hidden border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-cloud text-ash text-left text-xs font-semibold tracking-wider uppercase">
            <tr>
              <th className="px-4 py-2.5">Sub-processor</th>
              <th className="px-4 py-2.5">Purpose</th>
              <th className="px-4 py-2.5">Region</th>
              <th className="px-4 py-2.5">DPA</th>
            </tr>
          </thead>
          <tbody className="divide-hairline divide-y">
            {ROWS.map((r) => (
              <tr key={r.name}>
                <td className="text-ink px-4 py-3 font-semibold">{r.name}</td>
                <td className="text-charcoal px-4 py-3">{r.purpose}</td>
                <td className="text-charcoal px-4 py-3">{r.region}</td>
                <td className="text-charcoal px-4 py-3">{r.dpa}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-card border-hairline bg-cloud text-charcoal border p-4 text-sm">
        <h2 className="text-ink text-sm font-semibold">Subscribing to change notifications</h2>
        <p className="mt-1.5">
          Customers receive sub-processor change notifications on the email registered with their
          organisation. To request the countersigned DPA or to subscribe an additional contact,
          email{" "}
          <Link
            href="mailto:legal@tablekit.uk"
            className="text-ink hover:text-coral font-semibold underline underline-offset-4"
          >
            legal@tablekit.uk
          </Link>
          .
        </p>
      </section>

      <p className="text-ash text-xs">Last updated {LAST_UPDATED}.</p>
    </main>
  );
}
