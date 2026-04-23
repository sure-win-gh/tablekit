import Link from "next/link";

import { LoginForm } from "./form";

export const metadata = {
  title: "Sign in · TableKit",
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Use your password, or ask for a one-time link.
        </p>
        <div className="mt-8">
          <LoginForm />
        </div>
        <p className="mt-6 text-sm text-neutral-500">
          New here?{" "}
          <Link href="/signup" className="font-medium text-neutral-900 underline">
            Create an account
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
