"use client";

import { useActionState } from "react";

import { Button, Field, Select } from "@/components/ui";
import { suggestMapping } from "@/lib/import/suggest-mapping";
import type { ImportSource } from "@/lib/import/types";

import { type ConfirmState, confirmMapping } from "./actions";

const initial: ConfirmState = { status: "idle" };

const FIELDS = [
  { key: "firstName", label: "First name", required: true },
  { key: "lastName", label: "Last name", required: false },
  { key: "email", label: "Email", required: true },
  { key: "phone", label: "Phone", required: false },
  { key: "notes", label: "Notes", required: false },
] as const;

export function MappingForm({
  jobId,
  source,
  headers,
}: {
  jobId: string;
  source: ImportSource;
  headers: string[];
}) {
  const [state, formAction, pending] = useActionState(confirmMapping, initial);
  const suggested = suggestMapping(headers, source);

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={`${f.label}${f.required ? "" : " (optional)"}`}
            htmlFor={`map-${f.key}`}
          >
            <Select
              id={`map-${f.key}`}
              name={f.key}
              defaultValue={suggested[f.key] ?? ""}
              required={f.required}
            >
              <option value="">{f.required ? "Pick a column…" : "— skip —"}</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>

      {state.status === "error" ? (
        <p className="text-sm text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "running" ? (
        <p className="text-sm text-green-700">
          Import queued — refresh in a moment to see results.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Running…" : "Run import"}
        </Button>
        <p className="text-ash text-xs">
          We&apos;ll dedupe against your existing guests and write a rejected-rows report for any
          rows we can&apos;t import.
        </p>
      </div>
    </form>
  );
}
