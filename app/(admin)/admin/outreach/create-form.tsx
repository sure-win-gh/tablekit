"use client";

import { useActionState, useState } from "react";

import { Button, Field, Input } from "@/components/ui";

import { createOutreachClaim, type CreateClaimState } from "./actions";

const initial: CreateClaimState = { status: "idle" };

type CopyState = "idle" | "copied" | "failed";

// Mounted once per search result. The placeId is fixed by the parent;
// the founder fills in the prospect's contact details.
export function CreateClaimForm({ placeId, placeName }: { placeId: string; placeName: string }) {
  const [state, formAction, pending] = useActionState(createOutreachClaim, initial);
  const [copy, setCopy] = useState<CopyState>("idle");
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  if (state.status === "success") {
    return (
      <div className="border-hairline rounded-card flex flex-col gap-2 border bg-white p-3">
        <p className="text-ink text-sm font-semibold">Claimable account created for {placeName}</p>
        <p className="text-ash text-xs">
          Send this URL to {state.prospectEmail}. It expires{" "}
          {new Date(state.expiresAt).toLocaleDateString("en-GB")}. The link is shown once — closing
          this page loses it.
        </p>
        <div className="flex items-center gap-2">
          <Input readOnly value={state.claimUrl} className="font-mono text-xs" />
          <Button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.claimUrl);
                setCopy("copied");
              } catch {
                // Insecure context / permission denied — surface so the
                // founder copies manually rather than thinking it
                // landed on the clipboard.
                setCopy("failed");
              }
            }}
          >
            {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy"}
          </Button>
        </div>
        {copy === "failed" ? (
          <p role="alert" className="text-rose text-xs">
            Clipboard write blocked. Select the URL above and copy manually.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="placeId" value={placeId} />
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Prospect email"
          htmlFor={`email-${placeId}`}
          error={fieldErrors?.["prospectEmail"]?.[0]}
        >
          <Input
            id={`email-${placeId}`}
            name="prospectEmail"
            type="email"
            required
            placeholder="owner@theirvenue.co.uk"
            invalid={Boolean(fieldErrors?.["prospectEmail"]?.[0])}
          />
        </Field>
        <Field label="Prospect name (optional)" htmlFor={`name-${placeId}`}>
          <Input id={`name-${placeId}`} name="prospectName" type="text" placeholder="Alex" />
        </Field>
      </div>
      {state.status === "error" && !fieldErrors ? (
        <p role="alert" className="text-rose text-xs">
          {state.message}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create claimable account"}
        </Button>
      </div>
    </form>
  );
}
