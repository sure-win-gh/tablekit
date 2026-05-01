"use client";

import { useActionState, useState } from "react";

import { Button, Field, Input, Textarea, cn } from "@/components/ui";

import { submitDsarRequest, type SubmitDsarState } from "./actions";

const initial: SubmitDsarState = { status: "idle" };

const KIND_OPTIONS = [
  {
    value: "export",
    label: "Access / export",
    hint: "Get a copy of the personal data the venue holds about you.",
  },
  {
    value: "rectify",
    label: "Correction",
    hint: "Fix something the venue has wrong (e.g. spelling of your name, allergies, contact).",
  },
  {
    value: "erase",
    label: "Erasure",
    hint: "Remove your personal data. Bookings the venue must keep for accounting (7 years) will be pseudonymised.",
  },
] as const;

export function DsarRequestForm({ orgSlug, orgName }: { orgSlug: string; orgName: string }) {
  const [state, formAction, pending] = useActionState(submitDsarRequest, initial);
  const [kind, setKind] = useState<string>("export");

  if (state.status === "success") {
    return (
      <section className="rounded-card border border-emerald-300 bg-emerald-50 p-6 text-sm text-emerald-900">
        <h2 className="text-base font-bold tracking-tight">Request received.</h2>
        <p className="mt-1.5">
          {orgName} will respond to you by email within one calendar month. If you don&apos;t hear
          back, you can complain to the UK Information Commissioner&apos;s Office.
        </p>
      </section>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="orgSlug" value={orgSlug} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-ink text-xs font-semibold">What kind of request?</legend>
        <div className="flex flex-col gap-2">
          {KIND_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={cn(
                "rounded-card flex cursor-pointer items-start gap-3 border p-3 transition",
                kind === opt.value ? "border-ink bg-cloud" : "border-hairline hover:border-ink",
              )}
            >
              <input
                type="radio"
                name="kind"
                value={opt.value}
                required
                checked={kind === opt.value}
                onChange={(e) => setKind(e.target.value)}
                className="accent-ink mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-ink text-sm font-semibold">{opt.label}</span>
                <span className="text-ash text-xs">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        label="Your email"
        htmlFor="dsar-email"
        hint="The address the venue used for your booking."
      >
        <Input id="dsar-email" name="email" type="email" autoComplete="email" required />
      </Field>

      <Field label="Anything else we should know" htmlFor="dsar-message" optional>
        <Textarea
          id="dsar-message"
          name="message"
          rows={4}
          maxLength={2000}
          placeholder="Booking date or reference, what to correct, why you're submitting…"
        />
      </Field>

      {state.status === "error" ? (
        <p role="alert" className="text-rose text-sm">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-ash text-[11px]">
          Submitted requests are encrypted in transit and at rest. The venue, not TableKit, will
          contact you.
        </p>
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Submit request"}
        </Button>
      </div>
    </form>
  );
}
