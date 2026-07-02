import { cn } from "./cn";

// Loading placeholder. A single neutral block that pulses while the
// real content streams in. Compose several to mirror the shape of the
// page you're standing in for — that reads as faster than a spinner
// and avoids layout shift when the data lands.
//
// `aria-hidden` because the pulse is decorative; the route's own
// loading.tsx carries the announced "loading" semantics where needed.
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden className={cn("bg-cloud animate-pulse rounded", className)} {...props} />;
}
