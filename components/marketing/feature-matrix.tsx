import { Check, Minus } from "lucide-react";

import { Badge } from "@/components/ui";
import { FEATURES } from "@/lib/marketing/features";
import { PLANS, tierIncludes } from "@/lib/marketing/tiers";

// The full feature-by-tier matrix, rendered straight from the registry so
// it can never disagree with the feature pages. A real <table> with scope
// headers (accessible); horizontally scrollable on small screens.

export function FeatureMatrix() {
  return (
    <div className="rounded-card border-hairline overflow-x-auto border">
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <caption className="sr-only">TableKit plans and the features each one includes</caption>
        <thead>
          <tr className="border-hairline border-b">
            <th scope="col" className="text-ash px-4 py-3 text-sm font-semibold">
              Feature
            </th>
            {PLANS.map((plan) => (
              <th
                key={plan.tier}
                scope="col"
                className="text-ink px-4 py-3 text-center text-sm font-bold"
              >
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURES.map((feature) => (
            <tr key={feature.slug} className="border-hairline border-b last:border-0">
              <th
                scope="row"
                className="text-charcoal px-4 py-3 text-left text-sm font-medium"
              >
                <span className="flex items-center gap-2">
                  {feature.name}
                  {feature.status === "coming-soon" && <Badge tone="neutral">Soon</Badge>}
                </span>
              </th>
              {PLANS.map((plan) => {
                const included = tierIncludes(plan.tier, feature.tier);
                return (
                  <td key={plan.tier} className="px-4 py-3 text-center">
                    {included ? (
                      <>
                        <Check className="text-coral mx-auto size-5" aria-hidden />
                        <span className="sr-only">Included</span>
                      </>
                    ) : (
                      <>
                        <Minus className="text-stone mx-auto size-5" aria-hidden />
                        <span className="sr-only">Not included</span>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
