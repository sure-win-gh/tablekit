import { headers } from "next/headers";
import Link from "next/link";

import { visitorCountry } from "@/lib/geo/visitor-region";
import { regionEnabled } from "@/lib/regions/config";
import { DEFAULT_SIGNUP_COUNTRY, SIGNUP_COUNTRIES } from "@/lib/regions/mapping";

import { SignupForm } from "./form";

export const metadata = {
  title: "Sign up · TableKit",
};

// Pre-select the country picker from edge geo (best-effort). The value only
// pre-selects — the SELECTED country decides region/entity (D1). Any country
// not offered in the curated list (and US when the gate is closed) falls to
// "Other"/default, which resolves to EU/UK per D2.
function preselectCountry(geoCountry: string | null, usEnabled: boolean): string {
  if (!geoCountry) return DEFAULT_SIGNUP_COUNTRY;
  if (geoCountry === "US") return usEnabled ? "US" : DEFAULT_SIGNUP_COUNTRY;
  const offered = SIGNUP_COUNTRIES.some((c) => c.code === geoCountry && c.code !== "US");
  return offered ? geoCountry : "ZZ";
}

export default async function SignupPage() {
  const usEnabled = regionEnabled("us");
  const defaultCountry = preselectCountry(visitorCountry(await headers()), usEnabled);

  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-ink text-3xl font-bold tracking-tight">Create your account</h1>
        <p className="text-ash mt-1.5 text-sm">
          You&apos;ll be the owner of a new TableKit organisation. You can invite teammates later.
        </p>
        <div className="mt-8">
          <SignupForm usEnabled={usEnabled} defaultCountry={defaultCountry} />
        </div>
        <p className="text-ash mt-6 text-sm">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-ink hover:text-coral font-semibold underline underline-offset-4"
          >
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
