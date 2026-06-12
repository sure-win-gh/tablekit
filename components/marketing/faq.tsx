import { Plus } from "lucide-react";

import type { Faq as FaqItem } from "@/lib/marketing/content";

// Accessible FAQ accordion built on native <details>/<summary>: it works
// without JavaScript, is keyboard-operable for free, and the answers are
// real server-rendered text (so assistants and crawlers can read them).
// The same items feed FAQPage JSON-LD on the page.

export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="mx-auto max-w-2xl divide-y divide-hairline">
      {items.map((item) => (
        <details key={item.q} className="group py-4">
          <summary className="text-ink flex cursor-pointer list-none items-center justify-between gap-4 text-left font-semibold [&::-webkit-details-marker]:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-ink rounded-input">
            {item.q}
            <Plus
              className="text-ash size-5 shrink-0 transition-transform group-open:rotate-45 motion-reduce:transition-none"
              aria-hidden
            />
          </summary>
          <p className="text-ash mt-3 text-pretty">{item.a}</p>
        </details>
      ))}
    </div>
  );
}
