import Link from "next/link";

import { LoginForm } from "./form";

export const metadata = {
  title: "Sign in · TableKit",
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-ink text-3xl font-bold tracking-tight">Sign in</h1>
        <p className="text-ash mt-1.5 text-sm">Use your password, or ask for a one-time link.</p>
        <div className="mt-8">
          <LoginForm />
        </div>
        <p className="text-ash mt-6 text-sm">
          New here?{" "}
          <Link
            href="/signup"
            className="text-ink hover:text-coral font-semibold underline underline-offset-4"
          >
            Create an account
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
