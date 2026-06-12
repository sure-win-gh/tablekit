import { SiteHeader } from "@/components/marketing/site-header";

// Layout for the public marketing pages (home, pricing, features). Adds
// the marketing header and the <main> landmark; the footer + cookie notice
// come from the parent (marketing) layout, so they aren't duplicated and
// the functional routes (signup, login, legal, …) keep their plain chrome.

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
    </>
  );
}
