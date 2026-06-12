// Allowlisted lucide icon map. The registry stores icon names as strings;
// this resolves only the icons we actually use, so we don't pull the whole
// lucide set into the bundle. If you add a feature with a new icon, add it
// here too — TypeScript will flag a name that doesn't resolve.

import {
  ArrowLeftRight,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  ClipboardList,
  Code,
  Gauge,
  Globe,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

const ICONS = {
  ArrowLeftRight,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  ClipboardList,
  Code,
  Gauge,
  Globe,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Users,
  Webhook,
} satisfies Record<string, LucideIcon>;

// The set of valid icon names. Typing the registry's `icon` field as this
// (rather than `string`) makes a typo a compile error, as the comment above
// promises.
export type IconName = keyof typeof ICONS;

export function MarketingIcon({
  name,
  className,
  "aria-hidden": ariaHidden = true,
}: {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden={ariaHidden} />;
}
