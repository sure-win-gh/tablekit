// (widget) is a route group that holds public diner-facing surfaces.
// CookieNotice was here originally; it's now scoped down to /book and
// /review so the embed iframe (/embed/<venueId>) doesn't inherit it.
// Inside an iframe the parent site owns the cookie banner.

export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}
