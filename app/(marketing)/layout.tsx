import { CookieNotice } from "@/components/cookie-notice";
import { SiteFooter } from "@/components/site-footer";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col">{children}</div>
      <SiteFooter />
      <CookieNotice />
    </div>
  );
}
