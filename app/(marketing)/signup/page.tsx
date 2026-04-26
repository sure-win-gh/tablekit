import Link from "next/link";

import { SignupForm } from "./form";

export const metadata = {
  title: "Sign up · TableKit",
};

export default function SignupPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Create your account</h1>
        <p className="mt-1.5 text-sm text-ash">
          You&apos;ll be the owner of a new TableKit organisation. You can invite teammates later.
        </p>
        <div className="mt-8">
          <SignupForm />
        </div>
        <p className="mt-6 text-sm text-ash">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-ink underline underline-offset-4 hover:text-coral">
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
