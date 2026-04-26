import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";

// Inter as the open substitute for Airbnb Cereal — same proportions,
// same x-height ballpark, ships free via next/font. Loaded as a CSS
// variable so Tailwind v4's @theme block in globals.css can wire it
// into --font-sans without a config file.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TableKit",
  description: "UK table booking for independent hospitality.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
