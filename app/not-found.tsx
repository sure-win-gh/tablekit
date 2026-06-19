import Link from "next/link";

// Global 404. Served for unmatched routes and any explicit
// notFound() call that isn't caught by a closer not-found boundary.
// Server component — no client JS needed.

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-coral text-xs font-semibold tracking-wider uppercase">404</p>
      <h1 className="text-ink text-2xl font-bold tracking-tight">We can&rsquo;t find that page</h1>
      <p className="text-ash leading-relaxed">
        The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.
      </p>
      <Link
        href="/"
        className="bg-coral hover:bg-coral-deep rounded-input mt-3 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
      >
        Back to home
      </Link>
    </main>
  );
}
