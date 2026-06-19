import Link from "next/link";

import { resolveResetToken } from "@/lib/auth/password-reset";

import { ResetPasswordForm } from "./form";

export const metadata = {
  title: "Set a new password · TableKit",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  // Read-only peek so we can show the form or a clear "expired" state.
  // The action re-checks and atomically consumes on submit.
  const live = token ? await resolveResetToken(token) : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-ink text-3xl font-bold tracking-tight">Set a new password</h1>
        {live && token ? (
          <>
            <p className="text-ash mt-1.5 text-sm">Choose a new password for your account.</p>
            <div className="mt-8">
              <ResetPasswordForm token={token} />
            </div>
          </>
        ) : (
          <div className="rounded-card border-hairline bg-cloud text-charcoal mt-8 border p-4 text-sm">
            <p className="text-ink font-semibold">This link is invalid or has expired.</p>
            <p className="mt-1">
              Password reset links expire after 15 minutes and can only be used once.
            </p>
            <p className="mt-3">
              <Link
                href="/forgot-password"
                className="text-ink hover:text-coral font-semibold underline underline-offset-4"
              >
                Request a new link
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
