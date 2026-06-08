import { headers } from "next/headers";
import Link from "next/link";

import { visitorUkRegion } from "@/lib/geo/visitor-region";

// Footer used by the marketing surface (marketing landing, auth
// pages, legal pages). Two rows: brand + tagline on the left,
// link columns on the right; copyright underneath. Doesn't render
// on the dashboard or the embeddable widget — they have different
// surrounding chrome and the widget is intentionally minimal.

const LEGAL = [
  { href: "/privacy", label: "Privacy" },
  { href: "/legal/sub-processors", label: "Sub-processors" },
  { href: "/security", label: "Security" },
];

const PRODUCT = [
  { href: "/login", label: "Sign in" },
  { href: "/signup", label: "Sign up" },
];

// Developer surface — currently just the public API reference.
// Future: SDK packages, changelog, status page.
const DEVELOPERS = [{ href: "/docs/api", label: "API reference" }];

// "Made in …" label shown next to the copyright, tailored to the
// visitor's location: Wales gets the Welsh flag, the rest of the UK gets
// Great Britain, and visitors outside the UK see nothing.
const MADE_IN: Record<NonNullable<ReturnType<typeof visitorUkRegion>>, string> = {
  wales: "Made in Wales 🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "great-britain": "Made in Great Britain 🇬🇧",
};

export async function SiteFooter() {
  const year = new Date().getFullYear();
  const region = visitorUkRegion(await headers());
  const madeIn = region ? MADE_IN[region] : null;
  return (
    <footer className="border-hairline border-t bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:justify-between">
        <div className="max-w-xs">
          <p className="text-ink text-base font-bold tracking-tight">TableKit</p>
          <p className="text-ash mt-1.5 text-xs">UK table booking for independent hospitality.</p>
        </div>
        <div className="flex flex-wrap gap-10 text-xs">
          <FooterColumn label="Product" links={PRODUCT} />
          <FooterColumn label="Developers" links={DEVELOPERS} />
          <FooterColumn label="Legal" links={LEGAL} />
        </div>
      </div>
      <div className="border-hairline border-t">
        <div className="text-ash mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-2 gap-y-1 px-6 py-4 text-[11px]">
          <p>© {year} TableKit Ltd. All rights reserved.</p>
          {madeIn && <p className="text-charcoal">{madeIn}</p>}
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  label,
  links,
}: {
  label: string;
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ash text-[11px] font-semibold tracking-wider uppercase">{label}</p>
      <ul className="flex flex-col gap-1.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="text-charcoal hover:text-coral transition">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
