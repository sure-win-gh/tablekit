"use client";

import { useActionState, useTransition } from "react";

import {
  addSendingDomain,
  removeSendingDomain,
  verifyNowSendingDomain,
  type AddDomainState,
} from "./sending-domain-actions";

const initial: AddDomainState = { status: "idle" };

export type SendingDomainRow = {
  domain: string;
  status: "not_started" | "pending" | "verified" | "failure" | "temporary_failure";
  records: Array<{
    record?: string | null;
    name: string;
    type: string;
    value: string;
    ttl?: string | null;
    priority?: number | null;
  }>;
  lastCheckedAt: string | null;
};

export function SendingDomainSection({
  venueId,
  isOwner,
  row,
}: {
  venueId: string;
  isOwner: boolean;
  row: SendingDomainRow | null;
}) {
  return (
    <fieldset id="sending-domain" className="border-hairline flex flex-col gap-3 border-t pt-4">
      <legend className="text-ink text-sm font-semibold">
        AI enquiry handler — sending domain
      </legend>
      <p className="text-ash text-xs">
        By default, replies go from TableKit&apos;s shared domain (Gmail shows &quot;via
        tablekit.uk&quot; below the venue name). Add a domain you own to send from your venue&apos;s
        own address — add the DNS records Resend issues, click verify, and you&apos;re set.
      </p>

      {row ? (
        <DomainStatus venueId={venueId} row={row} isOwner={isOwner} />
      ) : (
        <AddForm venueId={venueId} disabled={!isOwner} />
      )}
    </fieldset>
  );
}

function AddForm({ venueId, disabled }: { venueId: string; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(addSendingDomain, initial);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="venue_id" value={venueId} />
      <div className="flex gap-2">
        <input
          type="text"
          name="domain"
          placeholder="mail.your-venue.co.uk"
          className="border-hairline focus:border-ink flex-1 rounded-md border px-3 py-1.5 text-sm outline-none disabled:opacity-50"
          required
          disabled={disabled || pending}
        />
        <button
          type="submit"
          disabled={disabled || pending}
          className="bg-ink hover:bg-charcoal rounded-md px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {disabled ? (
        <p className="text-ash text-xs">Only owners can add a sending domain.</p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-coral text-xs">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function DomainStatus({
  venueId,
  row,
  isOwner,
}: {
  venueId: string;
  row: SendingDomainRow;
  isOwner: boolean;
}) {
  const [verifyPending, startVerify] = useTransition();
  const [removePending, startRemove] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-ink text-sm font-mono">{row.domain}</p>
          {row.lastCheckedAt ? (
            <p className="text-ash text-[11px]">
              Last checked {new Date(row.lastCheckedAt).toLocaleString("en-GB")}
            </p>
          ) : null}
        </div>
        <StatusBadge status={row.status} />
      </div>

      {row.status !== "verified" ? (
        <DnsTable records={row.records} />
      ) : (
        <p className="text-xs text-emerald-700">
          Verified — enquiry replies will use this domain once that flow lands.
        </p>
      )}

      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          {row.status !== "verified" ? (
            <button
              type="button"
              disabled={verifyPending}
              onClick={() => startVerify(() => verifyNowSendingDomain({ venueId }))}
              className="bg-ink hover:bg-charcoal rounded-md px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50"
            >
              {verifyPending ? "Checking…" : "Verify now"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={removePending}
            onClick={() => {
              if (!window.confirm(`Remove ${row.domain}? You'll need to re-add + re-verify.`)) {
                return;
              }
              startRemove(() => removeSendingDomain({ venueId }));
            }}
            className="text-coral border-coral hover:bg-coral inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:text-white disabled:opacity-50"
          >
            {removePending ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : (
        <p className="text-ash text-xs">Only owners can manage the sending domain.</p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SendingDomainRow["status"] }) {
  const label =
    status === "verified"
      ? "VERIFIED"
      : status === "failure"
        ? "FAILED"
        : status === "temporary_failure"
          ? "RETRY"
          : status === "pending"
            ? "PENDING"
            : "NOT STARTED";
  const tone =
    status === "verified"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failure"
        ? "bg-rose-50 text-rose-700"
        : "bg-amber-50 text-amber-800";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${tone}`}
    >
      {label}
    </span>
  );
}

function DnsTable({ records }: { records: SendingDomainRow["records"] }) {
  if (records.length === 0) {
    return (
      <p className="text-ash text-xs">
        DNS records will appear after Resend issues them. Click &quot;Verify now&quot; if this
        screen looks stuck.
      </p>
    );
  }
  return (
    <div className="border-hairline overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-cloud text-ash">
          <tr>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">Host</th>
            <th className="px-2 py-1.5 font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i} className="border-t border-gray-100">
              <td className="px-2 py-1.5 font-mono">{r.type}</td>
              <td className="px-2 py-1.5 font-mono break-all">{r.name}</td>
              <td className="px-2 py-1.5 font-mono break-all">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-ash bg-cloud border-t border-gray-100 px-2 py-1.5 text-[11px]">
        Add these to your DNS host. Propagation can take a few minutes.
      </p>
    </div>
  );
}
