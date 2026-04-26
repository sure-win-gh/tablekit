import { CookieNotice } from "@/components/cookie-notice";

export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      {children}
      <CookieNotice />
    </div>
  );
}
