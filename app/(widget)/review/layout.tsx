import { CookieNotice } from "@/components/cookie-notice";

// The review-submission surface keeps the cookie notice (we set a
// first-party session cookie path through Supabase auth even though
// public review submitters aren't signed in — banner exists for the
// signed-in case if a guest is also an operator).

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CookieNotice />
    </>
  );
}
