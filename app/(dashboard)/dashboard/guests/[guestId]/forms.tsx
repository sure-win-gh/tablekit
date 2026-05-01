"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import { Badge, Button, Field, Input } from "@/components/ui";

import {
  requestGuestErasureAction,
  setMarketingConsentAction,
  updateGuestContactAction,
  type ConsentActionState,
  type ContactActionState,
  type EraseActionState,
} from "./actions";

const idleContact: ContactActionState = { status: "idle" };
const idleConsent: ConsentActionState = { status: "idle" };
const idleErase: EraseActionState = { status: "idle" };

// ---------------------------------------------------------------------------
// Edit contact card
// ---------------------------------------------------------------------------

export function EditContactCard({
  guestId,
  canEdit,
  erased,
  firstName,
  lastName,
  email,
  phone,
  emailInvalid,
  phoneInvalid,
}: {
  guestId: string;
  canEdit: boolean;
  erased: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  emailInvalid: boolean;
  phoneInvalid: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ContactActionState, FormData>(
    updateGuestContactAction,
    idleContact,
  );

  // The action revalidates the page — when state moves to "saved",
  // collapse the form on the next render so the read view shows
  // the fresh values.
  if (state.status === "saved" && editing) {
    setEditing(false);
  }

  return (
    <div className="rounded-card border-hairline border bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">Contact</h2>
        {canEdit && !erased && !editing ? (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form action={formAction} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="guestId" value={guestId} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="gp-fn">
              <Input
                id="gp-fn"
                name="firstName"
                defaultValue={firstName}
                required
                maxLength={80}
                autoComplete="given-name"
              />
            </Field>
            <Field label="Last name" htmlFor="gp-ln" optional>
              <Input
                id="gp-ln"
                name="lastName"
                defaultValue={lastName}
                maxLength={80}
                autoComplete="family-name"
              />
            </Field>
            <Field label="Email" htmlFor="gp-email">
              <Input
                id="gp-email"
                name="email"
                type="email"
                defaultValue={email}
                required
                maxLength={200}
                autoComplete="email"
              />
            </Field>
            <Field label="Phone" htmlFor="gp-phone" optional>
              <Input
                id="gp-phone"
                name="phone"
                type="tel"
                defaultValue={phone}
                maxLength={40}
                autoComplete="tel"
              />
            </Field>
          </div>
          {state.status === "error" ? <p className="text-rose text-xs">{state.message}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ash">Name</dt>
          <dd className="text-ink">{lastName ? `${firstName} ${lastName}` : firstName}</dd>
          <dt className="text-ash">Email</dt>
          <dd className="text-ink flex items-center gap-2">
            <span className="break-all">{email}</span>
            {emailInvalid ? <Badge tone="danger">Invalid</Badge> : null}
          </dd>
          <dt className="text-ash">Phone</dt>
          <dd className="text-ink flex items-center gap-2">
            <span>{phone || <span className="text-ash">—</span>}</span>
            {phoneInvalid && phone ? <Badge tone="danger">Invalid</Badge> : null}
          </dd>
        </dl>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-channel marketing consent toggles
// ---------------------------------------------------------------------------

export function ConsentToggles({
  guestId,
  erased,
  emailConsentAt,
  smsConsentAt,
}: {
  guestId: string;
  erased: boolean;
  emailConsentAt: string | null;
  smsConsentAt: string | null;
}) {
  return (
    <div className="rounded-card border-hairline border bg-white p-5">
      <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">Marketing consent</h2>
      <p className="text-ash mt-1 text-xs">
        Per-channel, timestamped. Withdrawal is at least as easy as opting in (Art 7(3)).
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <ChannelToggle
          guestId={guestId}
          channel="email"
          label="Email"
          consentAt={emailConsentAt}
          disabled={erased}
        />
        <ChannelToggle
          guestId={guestId}
          channel="sms"
          label="SMS"
          consentAt={smsConsentAt}
          disabled={erased}
        />
      </div>
    </div>
  );
}

function ChannelToggle({
  guestId,
  channel,
  label,
  consentAt,
  disabled,
}: {
  guestId: string;
  channel: "email" | "sms";
  label: string;
  consentAt: string | null;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState<ConsentActionState, FormData>(
    setMarketingConsentAction,
    idleConsent,
  );
  const on = Boolean(consentAt);
  const nextValue = on ? "false" : "true";
  const formattedAt = consentAt
    ? new Date(consentAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <form action={formAction} className="flex items-center justify-between gap-3">
      <input type="hidden" name="guestId" value={guestId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="consenting" value={nextValue} />
      <div className="flex flex-col">
        <span className="text-ink text-sm font-medium">{label}</span>
        <span className="text-ash text-xs">{on ? `Opted in ${formattedAt}` : "Not opted in"}</span>
        {state.status === "error" ? (
          <span className="text-rose text-xs">{state.message}</span>
        ) : null}
      </div>
      <Button
        type="submit"
        variant={on ? "destructive" : "secondary"}
        size="sm"
        disabled={pending || disabled}
      >
        {pending ? "…" : on ? "Opt out" : "Opt in"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Erase guest — two-step confirm. Routes via the DSAR inbox.
// ---------------------------------------------------------------------------

export function EraseGuestButton({ guestId }: { guestId: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [state, formAction, pending] = useActionState<EraseActionState, FormData>(
    async (prev, form) => {
      const r = await requestGuestErasureAction(prev, form);
      if (r.status === "created") {
        router.push(`/dashboard/privacy-requests/${r.dsarId}`);
      }
      return r;
    },
    idleErase,
  );

  if (!armed) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setArmed(true)}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Erase guest
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="guestId" value={guestId} />
      <span className="text-ash text-xs">
        Confirm? Routes via privacy requests with 30-day SLA.
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setArmed(false)}
        disabled={pending}
      >
        Cancel
      </Button>
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Filing…" : "Confirm erase"}
      </Button>
      {state.status === "error" ? <span className="text-rose text-xs">{state.message}</span> : null}
    </form>
  );
}
