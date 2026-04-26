import Link from "next/link";

import { LoginForm } from "./form";

export const metadata = {
  title: "Sign in · TableKit",
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold tracking-tight text-ink">Sign in</h1>
        <p className="mt-1.5 text-sm text-ash">
          Use your password, or ask for a one-time link.
        </p>
        <div className="mt-8">
          <LoginForm />
        </div>
        <p className="mt-6 text-sm text-ash">
          New here?{" "}
          <Link href="/signup" className="font-semibold text-ink underline underline-offset-4 hover:text-coral">
            Create an account
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
