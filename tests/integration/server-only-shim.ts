// Empty shim for the `server-only` package. In a Next.js build the
// real package errors if it's bundled into a client component; in
// Vitest (node env) there's no client bundle, so the check is
// irrelevant and we use this empty module instead.
export {};
