import { ChevronRight } from "lucide-react";
import Link from "next/link";

export const metadata = { title: "Legal · TableKit" };

// Index page for the legal section. Listed in order of likely
// reader: sub-processors first because that's the operational ask
// from prospective customers; privacy notice for guests; DPA
// summary; security policy.

const ENTRIES: Array<{ href: string; label: string; description: string }> = [
  {
    href: "/legal/sub-processors",
    label: "Sub-processors",
    description: "Third parties we use to deliver the service. Updated 30 days before any change.",
  },
  {
    href: "/privacy",
    label: "Privacy notice",
    description: "What we do with personal data, what your rights are, how to exercise them.",
  },
  {
    href: "/security",
    label: "Security",
    description: "Our security baseline, vulnerability disclosure, and how to reach us.",
  },
];

export default function LegalIndex() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-ink">Legal</h1>
        <p className="mt-1.5 text-sm text-ash">
          Operational documents — not legal advice. For data-protection requests please use the
          guest&apos;s venue rather than contacting us directly; we&apos;re a data processor on the
          venue&apos;s behalf.
        </p>
      </header>
      <ul className="flex flex-col gap-2">
        {ENTRIES.map((e) => (
          <li key={e.href}>
            <Link
              href={e.href}
              className="group flex items-center justify-between rounded-card border border-hairline bg-white px-4 py-3 transition hover:border-ink"
            >
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-ink">{e.label}</span>
                <span className="text-xs text-ash">{e.description}</span>
              </div>
              <ChevronRight
                className="h-4 w-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-ink"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
