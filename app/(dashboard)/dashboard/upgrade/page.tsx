import { Check } from "lucide-react";

import { Badge, Button, cn } from "@/components/ui";
import { requireRole } from "@/lib/auth/require-role";
import { FEATURES, type Feature } from "@/lib/auth/entitlements";
import { getPlan } from "@/lib/auth/require-plan";
import { planLevel, type Plan } from "@/lib/auth/plan-level";

export const metadata = { title: "Upgrade · TableKit" };

// Contact-to-upgrade for now — real Stripe subscription billing is a
// later feature (see docs/specs/plan-gating-paywall.md).
const UPGRADE_EMAIL = "hello@tablekit.uk";

const PLANS: Array<{ plan: Plan; price: string; tagline: string; features: string[] }> = [
  {
    plan: "free",
    price: "£0",
    tagline: "Up to 50 bookings a month.",
    features: ["Online booking widget", "Floor plan & timeline", "Email confirmations"],
  },
  {
    plan: "core",
    price: "£29",
    tagline: "Unlimited bookings for a single venue.",
    features: [
      "Everything in Free",
      "Unlimited bookings",
      "Deposits & card holds",
      "SMS & WhatsApp messaging",
      "Reserve with Google",
    ],
  },
  {
    plan: "plus",
    price: "£74",
    tagline: "Multi-venue and the AI toolkit.",
    features: [
      "Everything in Core",
      "Multi-venue & group overview",
      "AI enquiry handler",
      "Guest CRM & insights",
      "Campaigns & API access",
      "Priority support",
    ],
  },
];

const PLAN_LABEL: Record<Plan, string> = { free: "Free", core: "Core", plus: "Plus" };

function isFeature(v: string | undefined): v is Feature {
  return v !== undefined && v in FEATURES;
}

export default async function UpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ feature?: string }>;
}) {
  const { orgId } = await requireRole("host");
  const current = await getPlan(orgId);
  const { feature: featureParam } = await searchParams;
  const feature = isFeature(featureParam) ? featureParam : null;
  const targetPlan = feature ? FEATURES[feature].minPlan : null;

  return (
    <section className="flex flex-col gap-6 px-8 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-ink text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-ash text-sm">
          {feature ? (
            <>
              <span className="text-ink font-semibold">{FEATURES[feature].label}</span> is a{" "}
              {PLAN_LABEL[FEATURES[feature].minPlan]} feature. {FEATURES[feature].blurb}
            </>
          ) : (
            "Compare plans and pick the one that fits your venue."
          )}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {PLANS.map(({ plan, price, tagline, features }) => {
          const isCurrent = plan === current;
          const isTarget = plan === targetPlan;
          const isUpgrade = planLevel[plan] > planLevel[current];
          return (
            <div
              key={plan}
              className={cn(
                "rounded-card flex flex-col gap-4 border bg-white p-5",
                isTarget ? "border-coral shadow-panel" : "border-hairline",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-ink text-lg font-bold tracking-tight">{PLAN_LABEL[plan]}</h2>
                {isCurrent ? (
                  <Badge tone="neutral">Current plan</Badge>
                ) : isTarget ? (
                  <Badge tone="coral">Unlocks {FEATURES[feature!].label}</Badge>
                ) : null}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-ink text-3xl font-bold tracking-tight">{price}</span>
                {plan !== "free" ? <span className="text-ash text-sm">/ month + VAT</span> : null}
              </div>
              <p className="text-charcoal text-sm">{tagline}</p>
              <ul className="flex flex-col gap-1.5">
                {features.map((f) => (
                  <li key={f} className="text-charcoal flex items-start gap-2 text-sm">
                    <Check className="text-coral mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-2">
                {isCurrent ? (
                  <Button variant="secondary" size="md" className="w-full" disabled>
                    Your plan
                  </Button>
                ) : isUpgrade ? (
                  <a
                    href={`mailto:${UPGRADE_EMAIL}?subject=${encodeURIComponent(
                      `Upgrade to ${PLAN_LABEL[plan]}`,
                    )}`}
                  >
                    <Button
                      variant={isTarget ? "primary" : "secondary"}
                      size="md"
                      className="w-full"
                    >
                      Upgrade to {PLAN_LABEL[plan]}
                    </Button>
                  </a>
                ) : (
                  <Button variant="secondary" size="md" className="w-full" disabled>
                    Included below your plan
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-ash text-xs">
        Upgrades are handled by our team for now — email{" "}
        <a href={`mailto:${UPGRADE_EMAIL}`} className="text-coral hover:underline">
          {UPGRADE_EMAIL}
        </a>{" "}
        and we&apos;ll switch your plan over the same day.
      </p>
    </section>
  );
}
