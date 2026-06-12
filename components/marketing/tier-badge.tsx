import { Badge } from "@/components/ui";
import type { Tier } from "@/lib/marketing/tiers";

// Which plan a feature belongs to. Coral for Plus (the premium tier),
// neutral for Free/Core so the page doesn't turn into a colour salad —
// coral stays meaningful.

const LABEL: Record<Tier, string> = { free: "Free", core: "Core", plus: "Plus" };
const TONE: Record<Tier, "neutral" | "coral"> = {
  free: "neutral",
  core: "neutral",
  plus: "coral",
};

export function TierBadge({ tier }: { tier: Tier }) {
  return <Badge tone={TONE[tier]}>{LABEL[tier]}</Badge>;
}
