import Link from "next/link";

import { SignupForm } from "./form";

export const metadata = {
  title: "Sign up · TableKit",
};

export default function SignupPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-neutral-500">
          You&apos;ll be the owner of a new TableKit organisation. You can invite teammates later.
        </p>
        <div className="mt-8">
          <SignupForm />
        </div>
        <p className="mt-6 text-sm text-neutral-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-neutral-900 underline">
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
