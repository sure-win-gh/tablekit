import Link from "next/link";

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

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-hairline border-t bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:justify-between">
        <div className="max-w-xs">
          <p className="text-ink text-base font-bold tracking-tight">TableKit</p>
          <p className="text-ash mt-1.5 text-xs">UK table booking for independent hospitality.</p>
        </div>
        <div className="flex flex-wrap gap-10 text-xs">
          <FooterColumn label="Product" links={PRODUCT} />
          <FooterColumn label="Legal" links={LEGAL} />
        </div>
      </div>
      <div className="border-hairline border-t">
        <p className="text-ash mx-auto w-full max-w-5xl px-6 py-4 text-[11px]">
          © {year} TableKit Ltd. All rights reserved.
        </p>
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
