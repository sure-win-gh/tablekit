import { Menu } from "lucide-react";
import Link from "next/link";

import { CtaLink } from "./cta-link";
import { SIGNUP_HREF, SITE } from "@/lib/marketing/site";

// Marketing header. Sticky, fixed height (no layout shift), and fully
// server-rendered: the mobile menu uses a native <details> disclosure so
// it works without any JavaScript and stays keyboard-accessible for free.
// Only rendered on the (site) pages, not the functional routes.

const NAV = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
];

export function SiteHeader() {
  return (
    <header className="border-hairline sticky top-0 z-40 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <Link
          href="/"
          className="text-ink rounded-input focus-visible:ring-ink text-lg font-bold tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          {SITE.name}
        </Link>

        {/* Desktop nav */}
        <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-charcoal hover:text-coral text-sm font-medium transition"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link
            href="/login"
            className="text-charcoal hover:text-coral text-sm font-medium transition"
          >
            Sign in
          </Link>
          <CtaLink href={SIGNUP_HREF} size="md">
            Start free
          </CtaLink>
        </div>

        {/* Mobile menu — native disclosure, no JS required */}
        <details className="group relative md:hidden">
          <summary
            aria-label="Open menu"
            className="text-ink rounded-input border-hairline focus-visible:ring-ink flex size-10 cursor-pointer list-none items-center justify-center border focus:outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </summary>
          <div className="rounded-card border-hairline shadow-panel absolute right-0 mt-2 flex w-56 flex-col gap-1 border bg-white p-2">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-charcoal hover:bg-cloud rounded-input px-3 py-2 text-sm font-medium"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/login"
              className="text-charcoal hover:bg-cloud rounded-input px-3 py-2 text-sm font-medium"
            >
              Sign in
            </Link>
            <CtaLink href={SIGNUP_HREF} size="md" className="mt-1 w-full">
              Start free
            </CtaLink>
          </div>
        </details>
      </div>
    </header>
  );
}
