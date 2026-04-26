// Minimal class-name joiner. Skips falsy values so callers can use
// short-circuits inline (`className={cn("a", flag && "b")}`). Not a
// Tailwind-conflict resolver — when two competing utilities collide
// the *last* wins because Tailwind v4 generates utilities in source
// order and trailing classes override; consumers are expected not to
// fight the variant they passed in. If we ever need true conflict
// resolution we'll bring in tailwind-merge.

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
