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
        <h1 className="text-ink text-3xl font-bold tracking-tight">Legal</h1>
        <p className="text-ash mt-1.5 text-sm">
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
              className="group rounded-card border-hairline hover:border-ink flex items-center justify-between border bg-white px-4 py-3 transition"
            >
              <div className="flex flex-col">
                <span className="text-ink text-sm font-semibold">{e.label}</span>
                <span className="text-ash text-xs">{e.description}</span>
              </div>
              <ChevronRight
                className="text-mute group-hover:text-ink h-4 w-4 transition group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
