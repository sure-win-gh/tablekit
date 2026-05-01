"use client";

import { useActionState } from "react";

import { Button, Field, Select } from "@/components/ui";

import { type ActionState, uploadImport } from "./actions";

const initial: ActionState = { status: "idle" };

// PR4a only ships the generic-CSV path. The format-adapter PR (PR5)
// will populate the auto-detect logic + add the OpenTable / ResDiary
// / SevenRooms presets to the dropdown.
const SOURCES = [
  { value: "generic-csv", label: "Generic CSV" },
  { value: "opentable", label: "OpenTable export (preset coming in PR5)" },
  { value: "resdiary", label: "ResDiary export (preset coming in PR5)" },
  { value: "sevenrooms", label: "SevenRooms export (preset coming in PR5)" },
] as const;

export function ImportUploadForm() {
  const [state, formAction, pending] = useActionState(uploadImport, initial);

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-4">
      <Field label="CSV file" htmlFor="import-file">
        <input
          id="import-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="text-ash file:bg-cloud file:text-ink block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium file:hover:bg-stone-100"
        />
      </Field>

      <Field label="Source format" htmlFor="import-source">
        <Select id="import-source" name="source" defaultValue="generic-csv">
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>

      {state.status === "error" ? (
        <p className="text-sm text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Uploading…" : "Upload"}
        </Button>
        <p className="text-ash text-xs">
          Up to 50MB. The file is encrypted at rest under your organisation&apos;s key.
        </p>
      </div>
    </form>
  );
}
