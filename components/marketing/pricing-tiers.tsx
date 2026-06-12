import { Check } from "lucide-react";

import { Badge, cn } from "@/components/ui";
import { CtaLink } from "./cta-link";
import { PLANS } from "@/lib/marketing/tiers";
import { PRICING, SIGNUP_HREF } from "@/lib/marketing/site";

// Three-tier comparison. Core is the recommended default and is anchored
// visually (coral border, "Most popular", a slight lift) so a hesitant
// buyer has one obvious choice. Value (blurb + what-you-get) is framed
// before the price. Every price carries "+ VAT"; the at-cost fees note
// sits underneath. One CTA per tier, all the same single action.

export function PricingTiers() {
  return (
    <div>
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {PLANS.map((plan) => {
          const featured = plan.recommended;
          return (
            <div
              key={plan.tier}
              className={cn(
                "rounded-card flex h-full flex-col gap-5 border bg-white p-6",
                featured ? "border-coral shadow-panel lg:-mt-3 lg:pb-9" : "border-hairline",
              )}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-ink text-lg font-bold tracking-tight">{plan.name}</h3>
                {featured && <Badge tone="coral">Most popular</Badge>}
              </div>

              <p className="text-ash text-sm text-pretty">{plan.blurb}</p>

              <p className="flex items-baseline gap-1.5">
                {plan.pricePerMonth === 0 ? (
                  <span className="text-ink text-4xl font-bold tracking-tight">Free</span>
                ) : (
                  <>
                    <span className="text-ink text-4xl font-bold tracking-tight">
                      £{plan.pricePerMonth}
                    </span>
                    <span className="text-ash text-sm font-medium">{PRICING.vatNote} / month</span>
                  </>
                )}
              </p>

              <CtaLink href={SIGNUP_HREF} size="md" className="w-full">
                {plan.ctaLabel}
              </CtaLink>

              <p className="text-charcoal flex items-start gap-2 text-sm text-pretty">
                <Check className="text-coral mt-0.5 size-4 shrink-0" aria-hidden />
                {plan.headline}
              </p>
            </div>
          );
        })}
      </div>

      <p className="text-ash mt-6 text-center text-sm">
        {PRICING.feesNote} No card required to start. Cancel anytime.
      </p>
    </div>
  );
}
