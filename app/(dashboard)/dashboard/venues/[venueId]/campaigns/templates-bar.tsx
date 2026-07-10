"use client";

// Template picker + save-as-template for the email builder. Starters are
// code-defined (lib/campaigns/starter-templates.ts); saved templates are
// the org's own designs, loaded server-side (RLS) and kept in local state
// here so saves/deletes reflect instantly.

import { useState } from "react";

import type { CampaignBodyDoc } from "@/lib/campaigns/blocks";
import { STARTER_TEMPLATES } from "@/lib/campaigns/starter-templates";

import { deleteCampaignTemplate, saveCampaignTemplate } from "./actions";

export type SavedTemplate = {
  id: string;
  name: string;
  subject: string | null;
  doc: CampaignBodyDoc;
};

export function TemplatesBar({
  saved,
  currentDoc,
  currentSubject,
  onApply,
}: {
  saved: SavedTemplate[];
  currentDoc: CampaignBodyDoc | null;
  currentSubject: string;
  onApply: (doc: CampaignBodyDoc, subject: string | null) => void;
}) {
  const [templates, setTemplates] = useState<SavedTemplate[]>(saved);
  const [selected, setSelected] = useState("");
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedSaved = selected.startsWith("saved:")
    ? templates.find((t) => t.id === selected.slice(6))
    : undefined;

  function apply() {
    setMessage(null);
    if (selected.startsWith("starter:")) {
      const s = STARTER_TEMPLATES.find((t) => t.key === selected.slice(8));
      if (s) onApply(structuredClone(s.doc), s.subject);
    } else if (selectedSaved) {
      onApply(structuredClone(selectedSaved.doc), selectedSaved.subject);
    }
  }

  async function save() {
    if (!currentDoc) return;
    setBusy(true);
    setMessage(null);
    const r = await saveCampaignTemplate({
      name: saveName,
      subject: currentSubject,
      bodyDoc: currentDoc,
    });
    setBusy(false);
    if (r.ok) {
      setTemplates((ts) => [
        ...ts,
        { id: r.id, name: r.name, subject: currentSubject || null, doc: currentDoc },
      ]);
      setSaveName("");
      setMessage(`Saved "${r.name}".`);
    } else {
      setMessage(r.message);
    }
  }

  async function remove() {
    if (!selectedSaved) return;
    setBusy(true);
    setMessage(null);
    await deleteCampaignTemplate({ id: selectedSaved.id });
    setBusy(false);
    setTemplates((ts) => ts.filter((t) => t.id !== selectedSaved.id));
    setSelected("");
    setMessage(`Deleted "${selectedSaved.name}".`);
  }

  return (
    <div className="border-hairline bg-cloud/50 flex flex-wrap items-center gap-2 rounded-md border p-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink text-xs font-medium">Start from</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="border-hairline max-w-56 rounded-md border bg-white px-2 py-1.5 text-xs"
        >
          <option value="">Choose a template…</option>
          <optgroup label="Starters">
            {STARTER_TEMPLATES.map((s) => (
              <option key={s.key} value={`starter:${s.key}`} title={s.description}>
                {s.name}
              </option>
            ))}
          </optgroup>
          {templates.length > 0 ? (
            <optgroup label="My templates">
              {templates.map((t) => (
                <option key={t.id} value={`saved:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <button
        type="button"
        onClick={apply}
        disabled={!selected || busy}
        className="bg-ink rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        Use template
      </button>
      {selectedSaved ? (
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy}
          className="text-ash text-xs underline underline-offset-2 hover:text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      ) : null}

      <span className="border-hairline mx-1 hidden h-5 border-l sm:inline-block" aria-hidden />

      <input
        value={saveName}
        onChange={(e) => setSaveName(e.target.value)}
        maxLength={80}
        placeholder="Name this design…"
        className="border-hairline min-w-36 flex-1 rounded-md border bg-white px-2 py-1.5 text-xs"
      />
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || !currentDoc || !saveName.trim()}
        title={!currentDoc ? "Add some content first" : undefined}
        className="border-hairline hover:border-ink rounded-md border bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save as template"}
      </button>

      {message ? (
        <p aria-live="polite" className="text-ash w-full text-xs">
          {message}
        </p>
      ) : null}
    </div>
  );
}
