import Link from "next/link";

import { DocsNav } from "./nav";

// Shared shell for the developer docs: wordmark + tab bar, content
// below. Deliberately a top bar (not a sidebar) — the API-reference
// page embeds Stoplight Elements, which brings its own sidebar, and
// two nested sidebars is one too many.

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-ink text-base font-semibold tracking-tight">
            TableKit
          </Link>
          <span className="text-ash text-sm">Developer documentation</span>
        </div>
        <Link href="/dashboard" className="text-ash hover:text-ink text-sm">
          Dashboard →
        </Link>
      </header>
      <DocsNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
