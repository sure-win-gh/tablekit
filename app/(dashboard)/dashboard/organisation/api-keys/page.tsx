import { ChevronRight, KeyRound } from "lucide-react";
import Link from "next/link";

import { LockedFeature } from "@/components/billing/locked-feature";
import { loadApiKeys } from "@/lib/api-keys/list";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan, toPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { organisations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { CreateKeyForm, RevokeKeyButton } from "./forms";

export const metadata = { title: "API keys · TableKit" };
export const dynamic = "force-dynamic";

// Owner-only Plus-tier API key management.
//
// Lists existing keys (label, prefix, last-used, status), lets the
// owner create a new one (plaintext shown once), and revoke. The
// plaintext is never persisted — only its SHA-256 hash. Lookup at
// auth time hashes the incoming Bearer token and compares.

export default async function ApiKeysPage() {
  const { orgId, role } = await requireRole("owner");
  const orgPlan = await getPlan(orgId);
  if (isLocked(orgPlan, "apiKeys")) {
    return <LockedFeature feature="apiKeys" currentPlan={orgPlan} />;
  }

  const { keys, plan } = await withUser(async (db) => {
    const [o] = await db
      .select({ plan: organisations.plan })
      .from(organisations)
      .where(eq(organisations.id, orgId))
      .limit(1);
    const k = await loadApiKeys(db, orgId);
    return { keys: k, plan: o?.plan ?? "free" };
  });

  // Belt-and-braces — requirePlan above already guarantees this.
  if (!hasPlan(toPlan(plan), "plus")) {
    throw new Error("ApiKeysPage: requirePlan failed open");
  }
  void role;

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href="/dashboard/organisation" className="hover:text-ink">
          Organisation
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">API keys</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <KeyRound className="text-coral h-6 w-6" aria-hidden />
          API keys
        </h1>
        <p className="text-ash mt-1 text-sm">
          Bearer tokens for the public REST API at{" "}
          <span className="font-mono">api.tablekit.uk/v1</span>. Each key is scoped to this
          organisation. We store only the hash — copy the plaintext when it&apos;s shown. See the{" "}
          <Link href="/docs/api" className="underline" target="_blank">
            API reference
          </Link>{" "}
          for endpoint docs.
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">Create a new key</h2>
        <CreateKeyForm />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-ink text-sm font-semibold tracking-tight">
          Existing keys ({keys.length})
        </h2>
        {keys.length === 0 ? (
          <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
            No keys yet. Create one above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((k) => (
              <li
                key={k.id}
                className="rounded-card border-hairline flex items-start justify-between gap-4 border bg-white p-4"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ink text-sm font-semibold">{k.label}</span>
                    <code className="text-ash font-mono text-xs">{k.prefix}…</code>
                    <StatusBadge revokedAt={k.revokedAt} />
                  </div>
                  <p className="text-ash mt-1 text-xs">
                    Created {k.createdAt.toLocaleDateString("en-GB")} ·{" "}
                    {k.lastUsedAt
                      ? `last used ${k.lastUsedAt.toLocaleDateString("en-GB")}`
                      : "never used"}
                    {k.revokedAt ? ` · revoked ${k.revokedAt.toLocaleDateString("en-GB")}` : ""}
                  </p>
                </div>
                {k.revokedAt ? null : <RevokeKeyButton keyId={k.id} label={k.label} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusBadge({ revokedAt }: { revokedAt: Date | null }) {
  if (revokedAt) {
    return (
      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500">
        Revoked
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
      Active
    </span>
  );
}
