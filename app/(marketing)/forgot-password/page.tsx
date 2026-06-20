import Link from "next/link";

import { ForgotPasswordForm } from "./form";

export const metadata = {
  title: "Reset your password · TableKit",
};

export default function ForgotPasswordPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-ink text-3xl font-bold tracking-tight">Reset your password</h1>
        <p className="text-ash mt-1.5 text-sm">
          Enter your email and we&rsquo;ll send you a link to set a new password.
        </p>
        <div className="mt-8">
          <ForgotPasswordForm />
        </div>
        <p className="text-ash mt-6 text-sm">
          Remembered it?{" "}
          <Link
            href="/login"
            className="text-ink hover:text-coral font-semibold underline underline-offset-4"
          >
            Back to sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
