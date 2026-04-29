// Iframe target. Skips the cookie banner — the parent site owns
// cookie consent — and avoids any chrome that doesn't belong inside
// a third-party page. The (widget) parent layout is a passthrough.

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
