import { CookieNotice } from "@/components/cookie-notice";

// Hosted booking page chrome. The embed iframe lives at
// /embed/<venueId> and skips this — the parent site owns the cookie
// banner there.

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CookieNotice />
    </>
  );
}
