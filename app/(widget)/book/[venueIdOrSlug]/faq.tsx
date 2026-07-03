// Derived FAQ section (Core+). Server component — native <details>
// disclosure, no client JS. Content comes from buildFaq (lib/public/faq)
// so every answer is grounded in operator-provided data.

import type { FaqItem } from "@/lib/public/faq";

export function FaqSection({ items }: { items: FaqItem[] }) {
  if (items.length === 0) return null;
  return (
    <section
      id="faq"
      aria-label="Frequently asked questions"
      className="border-hairline flex scroll-mt-16 flex-col gap-3 border-t pt-6"
    >
      <h2 className="text-ink text-lg font-bold tracking-tight">Frequently asked questions</h2>
      <div className="flex flex-col gap-2">
        {items.map((f) => (
          <details key={f.q} className="rounded-card border-hairline border bg-white px-4 py-3">
            <summary className="text-ink cursor-pointer text-sm font-semibold select-none">
              {f.q}
            </summary>
            <p className="text-charcoal mt-2 text-sm whitespace-pre-line">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
