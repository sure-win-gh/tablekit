"use client";

// Block-based email builder (marketing-suite Phase A). Client-side editing
// state only — the doc is re-validated server-side on preview, test-send
// and create (lib/campaigns/blocks.ts is the boundary).

import {
  AlignCenter,
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  Trash2,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import type { CampaignBlock, DocTheme } from "@/lib/campaigns/blocks";

import { uploadCampaignImage } from "./actions";

const DEFAULT_INK = "#111111";

// --- Theme panel (doc-level styling: set once, blocks can override) ---------

const FONT_LABEL: Record<NonNullable<DocTheme["font"]>, string> = {
  modern: "Modern (sans-serif)",
  classic: "Classic (serif)",
  elegant: "Elegant (Palatino)",
  mono: "Typewriter (mono)",
};

export function ThemePanel({
  theme,
  onChange,
  brandColour,
}: {
  theme: DocTheme;
  onChange: (t: DocTheme) => void;
  brandColour: string | null;
}) {
  return (
    <div className="border-hairline bg-cloud/50 flex flex-wrap items-end gap-3 rounded-md border p-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-ink font-medium">Font</span>
        <select
          value={theme.font ?? "modern"}
          onChange={(e) =>
            onChange({ ...theme, font: e.target.value as NonNullable<DocTheme["font"]> })
          }
          className="border-hairline rounded-md border bg-white px-2 py-1.5 text-xs"
        >
          {(Object.keys(FONT_LABEL) as (keyof typeof FONT_LABEL)[]).map((f) => (
            <option key={f} value={f}>
              {FONT_LABEL[f]}
            </option>
          ))}
        </select>
      </label>
      <ColourField
        label="Accent"
        hint="buttons & headings"
        value={theme.accent}
        fallback={brandColour ?? DEFAULT_INK}
        onChange={(v) => onChange({ ...theme, accent: v })}
      />
      <ColourField
        label="Text"
        value={theme.textColour}
        fallback={DEFAULT_INK}
        onChange={(v) => onChange({ ...theme, textColour: v })}
      />
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-ink font-medium">Button shape</span>
        <select
          value={theme.buttonShape ?? "rounded"}
          onChange={(e) =>
            onChange({
              ...theme,
              buttonShape: e.target.value as NonNullable<DocTheme["buttonShape"]>,
            })
          }
          className="border-hairline rounded-md border bg-white px-2 py-1.5 text-xs"
        >
          <option value="square">Square</option>
          <option value="rounded">Rounded</option>
          <option value="pill">Pill</option>
        </select>
      </label>
      <p className="text-ash w-full text-xs sm:w-auto sm:flex-1 sm:text-right">
        Applies to the whole email; each block can override below.
      </p>
    </div>
  );
}

// Colour swatch with an "Auto" reset — unset means "follow the theme /
// venue branding", which is what keeps emails on-brand by default.
function ColourField({
  label,
  hint,
  value,
  fallback,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  fallback: string;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink font-medium">
        {label}
        {hint ? <span className="text-ash ml-1 font-normal">({hint})</span> : null}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} colour`}
          className="border-hairline h-7 w-10 cursor-pointer rounded border bg-white p-0.5"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-ash hover:text-charcoal text-xs underline underline-offset-2"
          >
            Auto
          </button>
        ) : (
          <span className="text-ash text-xs">Auto</span>
        )}
      </span>
    </label>
  );
}

// Left/centre alignment toggle for text-bearing blocks.
function AlignField({
  value,
  onChange,
}: {
  value: "left" | "center" | undefined;
  onChange: (v: "left" | "center" | undefined) => void;
}) {
  const current = value ?? "left";
  return (
    <span
      className="border-hairline flex gap-0.5 rounded-md border bg-white p-0.5"
      role="group"
      aria-label="Alignment"
    >
      {(
        [
          ["left", AlignLeft, "Align left"],
          ["center", AlignCenter, "Align centre"],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={current === v}
          onClick={() => onChange(v === "left" ? undefined : v)}
          className={
            current === v
              ? "bg-ink rounded p-1 text-white"
              : "text-ash hover:text-charcoal rounded p-1"
          }
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </span>
  );
}

export type EditorBlock = { _id: string } & CampaignBlock;

export function newBlock(type: CampaignBlock["type"]): EditorBlock {
  const _id = crypto.randomUUID();
  switch (type) {
    case "heading":
      return { _id, type, text: "", level: 2 };
    case "text":
      return { _id, type, text: "" };
    case "image":
      return { _id, type, src: "", alt: "", widthPct: 100 };
    case "button":
      return { _id, type, label: "", url: "", style: "filled" };
    case "bookingCta":
      return { _id, type, label: "Book a table", style: "filled" };
    case "countdown":
      return { _id, type, target: "" };
    case "social":
      return { _id, type };
    case "divider":
      return { _id, type };
    case "spacer":
      return { _id, type, size: "m" };
  }
}

// Serializable doc for the server: strip editor ids, drop incomplete
// blocks the schema would reject anyway (e.g. an image never uploaded).
export function toDocBlocks(blocks: EditorBlock[]): CampaignBlock[] {
  return blocks
    .filter((b) => {
      if (b.type === "heading" || b.type === "text") return b.text.trim().length > 0;
      if (b.type === "image") return b.src.trim().length > 0 && b.alt.trim().length > 0;
      if (b.type === "button") return b.label.trim().length > 0 && b.url.trim().length > 0;
      if (b.type === "bookingCta") return b.label.trim().length > 0;
      if (b.type === "countdown") return b.target.trim().length > 0;
      if (b.type === "social") return Boolean(b.instagram || b.facebook || b.x || b.website);
      return true;
    })
    .map(({ _id: _drop, ...block }) => block);
}

const PALETTE: { type: CampaignBlock["type"]; label: string }[] = [
  { type: "heading", label: "Heading" },
  { type: "text", label: "Text" },
  { type: "image", label: "Image" },
  { type: "button", label: "Button" },
  { type: "bookingCta", label: "Book button" },
  { type: "countdown", label: "Countdown" },
  { type: "social", label: "Social links" },
  { type: "divider", label: "Divider" },
  { type: "spacer", label: "Spacer" },
];

const inputCls = "border-hairline rounded-md border px-2.5 py-1.5 text-sm";

const NEW_BLOCK_MIME = "application/x-tk-new-block";

const BLOCK_LABEL: Record<CampaignBlock["type"], string> = Object.fromEntries(
  PALETTE.map((p) => [p.type, p.label]),
) as Record<CampaignBlock["type"], string>;

export function EmailBuilder({
  venueId,
  blocks,
  onChange,
  theme,
  brandColour,
}: {
  venueId: string;
  blocks: EditorBlock[];
  onChange: (blocks: EditorBlock[]) => void;
  theme: DocTheme;
  brandColour: string | null;
}) {
  // Resolved fallbacks so per-block colour swatches display what will
  // actually render when the block hasn't set its own colour.
  const accentFallback = theme.accent ?? brandColour ?? DEFAULT_INK;
  const textFallback = theme.textColour ?? DEFAULT_INK;
  // Drag state. HTML5 DnD: dragging an existing block (dragIdx) or a new
  // one from the palette (the dataTransfer type tells us which). dropIdx
  // is the insertion point (0..blocks.length) shown as an indicator line.
  // The card is only draggable while its grip handle is pressed, so text
  // selection inside inputs keeps working.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [handleHeld, setHandleHeld] = useState<string | null>(null);

  const update = (id: string, patch: Partial<CampaignBlock>) =>
    onChange(blocks.map((b) => (b._id === id ? ({ ...b, ...patch } as EditorBlock) : b)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (id: string) => onChange(blocks.filter((b) => b._id !== id));
  const duplicate = (i: number) => {
    const src = blocks[i];
    if (!src) return;
    const copy = { ...src, _id: crypto.randomUUID() };
    onChange([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)]);
  };

  const resetDrag = () => {
    setDragIdx(null);
    setDropIdx(null);
    setHandleHeld(null);
  };

  // Insertion index from the hover position: top half → before, bottom
  // half → after the hovered card.
  const hoverIndex = (e: DragEvent, i: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? i : i + 1;
  };

  const performDrop = (e: DragEvent) => {
    e.preventDefault();
    const at = dropIdx ?? blocks.length;
    const paletteType = e.dataTransfer.getData(NEW_BLOCK_MIME) as CampaignBlock["type"] | "";
    if (paletteType) {
      const next = [...blocks];
      next.splice(at, 0, newBlock(paletteType));
      onChange(next);
    } else if (dragIdx !== null) {
      const target = at > dragIdx ? at - 1 : at;
      if (target !== dragIdx) {
        const next = [...blocks];
        const [moved] = next.splice(dragIdx, 1);
        next.splice(target, 0, moved!);
        onChange(next);
      }
    }
    resetDrag();
  };

  const indicator = (at: number) => (
    <div
      aria-hidden
      className={`bg-coral rounded-full transition-all duration-150 ${dropIdx === at && (dragIdx !== null || dropIdx !== null) ? "my-1 h-1 opacity-100" : "h-0 opacity-0"}`}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-ink text-sm font-medium">Blocks</span>
        <span className="text-ash text-xs">— tap to add, or drag into place:</span>
        {PALETTE.map((p) => (
          <button
            key={p.type}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(NEW_BLOCK_MIME, p.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDragEnd={resetDrag}
            onClick={() => onChange([...blocks, newBlock(p.type)])}
            className="border-hairline hover:border-ink cursor-grab rounded-md border bg-white px-2.5 py-1 text-xs font-semibold active:cursor-grabbing"
          >
            + {p.label}
          </button>
        ))}
      </div>

      <ul
        className="flex flex-col"
        onDragOver={(e) => {
          e.preventDefault(); // allow dropping anywhere in the canvas
          if (blocks.length === 0) setDropIdx(0);
        }}
        onDrop={performDrop}
        onDragLeave={(e) => {
          // Only clear when leaving the canvas entirely, not between cards.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIdx(null);
        }}
      >
        {blocks.length === 0 ? (
          <li
            className={`text-ash rounded-md border border-dashed p-6 text-center text-sm transition-colors ${dropIdx === 0 ? "border-coral bg-coral/5" : "border-hairline"}`}
          >
            Drag a block here — or tap one above — to start your email.
          </li>
        ) : (
          blocks.map((b, i) => (
            <li key={b._id} className="flex flex-col">
              {indicator(i)}
              <div
                draggable={handleHeld === b._id}
                onDragStart={(e) => {
                  setDragIdx(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={resetDrag}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropIdx(hoverIndex(e, i));
                }}
                className={`border-hairline mb-2 rounded-md border bg-white p-3 transition-opacity duration-150 ${dragIdx === i ? "opacity-40" : "opacity-100"}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`Drag to move ${BLOCK_LABEL[b.type]}`}
                      title="Drag to move"
                      onMouseDown={() => setHandleHeld(b._id)}
                      onMouseUp={() => setHandleHeld(null)}
                      className="text-stone hover:text-charcoal -ml-1 cursor-grab p-1 active:cursor-grabbing"
                    >
                      <GripVertical className="h-4 w-4" aria-hidden />
                    </button>
                    <span className="text-ash text-xs font-semibold tracking-wider uppercase">
                      {BLOCK_LABEL[b.type]}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      onClick={() => move(i, 1)}
                      disabled={i === blocks.length - 1}
                    >
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </IconBtn>
                    <IconBtn label="Duplicate" onClick={() => duplicate(i)}>
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </IconBtn>
                    <IconBtn label="Delete" onClick={() => remove(b._id)}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </IconBtn>
                  </span>
                </div>
                <BlockFields
                  block={b}
                  venueId={venueId}
                  accentFallback={accentFallback}
                  textFallback={textFallback}
                  update={(patch) => update(b._id, patch)}
                />
              </div>
              {i === blocks.length - 1 ? indicator(blocks.length) : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="border-hairline text-charcoal hover:border-ink rounded border bg-white p-1 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function BlockFields({
  block,
  venueId,
  accentFallback,
  textFallback,
  update,
}: {
  block: EditorBlock;
  venueId: string;
  accentFallback: string;
  textFallback: string;
  update: (patch: Partial<CampaignBlock>) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={block.text}
            onChange={(e) => update({ text: e.target.value })}
            maxLength={150}
            placeholder="June supper club"
            className={`${inputCls} min-w-40 flex-1`}
          />
          <select
            value={block.level}
            onChange={(e) => update({ level: Number(e.target.value) as 1 | 2 })}
            className={inputCls}
            aria-label="Heading size"
          >
            <option value={1}>Large</option>
            <option value={2}>Small</option>
          </select>
          <AlignField value={block.align} onChange={(align) => update({ align })} />
          <ColourField
            label="Colour"
            value={block.colour}
            fallback={accentFallback}
            onChange={(colour) => update({ colour })}
          />
        </div>
      );
    case "text":
      return (
        <>
          <textarea
            value={block.text}
            onChange={(e) => update({ text: e.target.value })}
            rows={4}
            maxLength={2000}
            placeholder={"Hi {{guestFirstName}},\n\nWe'd love to see you…"}
            className={`${inputCls} w-full font-mono`}
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select
              value={block.size ?? "m"}
              onChange={(e) =>
                update({ size: e.target.value === "m" ? undefined : (e.target.value as "s" | "l") })
              }
              className={inputCls}
              aria-label="Text size"
            >
              <option value="s">Small</option>
              <option value="m">Normal</option>
              <option value="l">Large</option>
            </select>
            <AlignField value={block.align} onChange={(align) => update({ align })} />
            <ColourField
              label="Colour"
              value={block.colour}
              fallback={textFallback}
              onChange={(colour) => update({ colour })}
            />
            <p className="text-ash text-xs">
              **bold**, *italic*, [link](https://…) and merge tags supported.
            </p>
          </div>
        </>
      );
    case "image":
      return <ImageFields block={block} venueId={venueId} update={update} />;
    case "button":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              value={block.label}
              onChange={(e) => update({ label: e.target.value })}
              maxLength={80}
              placeholder="Book a table"
              className={`${inputCls} flex-1`}
            />
            <input
              value={block.url}
              onChange={(e) => update({ url: e.target.value })}
              type="url"
              placeholder="https://…"
              className={`${inputCls} flex-[2]`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={block.style}
              onChange={(e) => update({ style: e.target.value as "filled" | "outline" })}
              className={inputCls}
              aria-label="Button style"
            >
              <option value="filled">Filled</option>
              <option value="outline">Outline</option>
            </select>
            <AlignField value={block.align} onChange={(align) => update({ align })} />
            <ColourField
              label="Colour"
              value={block.colour}
              fallback={accentFallback}
              onChange={(colour) => update({ colour })}
            />
          </div>
        </div>
      );
    case "bookingCta":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              value={block.label}
              onChange={(e) => update({ label: e.target.value })}
              maxLength={80}
              placeholder="Book a table"
              className={`${inputCls} flex-1`}
            />
            <select
              value={block.style}
              onChange={(e) => update({ style: e.target.value as "filled" | "outline" })}
              className={inputCls}
              aria-label="Button style"
            >
              <option value="filled">Filled</option>
              <option value="outline">Outline</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-ash flex items-center gap-1.5 text-xs">
              Pre-fill guests
              <input
                type="number"
                min={1}
                max={20}
                value={block.party ?? ""}
                onChange={(e) =>
                  update({ party: e.target.value ? Number(e.target.value) : undefined })
                }
                className={`${inputCls} w-16`}
              />
            </label>
            <label className="text-ash flex items-center gap-1.5 text-xs">
              Pre-fill date
              <input
                type="date"
                value={block.date ?? ""}
                onChange={(e) => update({ date: e.target.value || undefined })}
                className={inputCls}
              />
            </label>
            <AlignField value={block.align} onChange={(align) => update({ align })} />
            <ColourField
              label="Colour"
              value={block.colour}
              fallback={accentFallback}
              onChange={(colour) => update({ colour })}
            />
          </div>
          <p className="text-ash text-xs">
            Links straight to your booking page — the address and campaign tracking are added
            automatically.
          </p>
        </div>
      );
    case "countdown":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-ash flex items-center gap-1.5 text-xs">
              Counts down to
              <input
                type="datetime-local"
                value={block.target}
                onChange={(e) => update({ target: e.target.value })}
                className={inputCls}
              />
            </label>
            <input
              value={block.caption ?? ""}
              onChange={(e) => update({ caption: e.target.value || undefined })}
              maxLength={150}
              placeholder="Caption (optional)"
              className={`${inputCls} flex-1`}
            />
          </div>
          <p className="text-ash text-xs">
            Shows the time remaining when the guest opens the email, then &ldquo;IT&apos;S
            ON!&rdquo; once it passes. Some mail apps show a snapshot from when they pre-load the
            email.
          </p>
        </div>
      );
    case "social":
      return (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              ["instagram", "Instagram URL"],
              ["facebook", "Facebook URL"],
              ["x", "X URL"],
              ["website", "Website URL"],
            ] as const
          ).map(([field, placeholder]) => (
            <input
              key={field}
              value={(block[field] as string | undefined) ?? ""}
              onChange={(e) => update({ [field]: e.target.value.trim() || undefined })}
              type="url"
              placeholder={placeholder}
              className={inputCls}
            />
          ))}
        </div>
      );
    case "divider":
      return (
        <div className="flex items-center gap-3">
          <hr
            className="flex-1 border-t"
            style={{ borderColor: block.colour ?? "#e5e5e5" }}
            aria-hidden
          />
          <ColourField
            label="Colour"
            value={block.colour}
            fallback="#e5e5e5"
            onChange={(colour) => update({ colour })}
          />
        </div>
      );
    case "spacer":
      return (
        <select
          value={block.size}
          onChange={(e) => update({ size: e.target.value as "s" | "m" | "l" })}
          className={inputCls}
          aria-label="Spacer size"
        >
          <option value="s">Small</option>
          <option value="m">Medium</option>
          <option value="l">Large</option>
        </select>
      );
  }
}

function ImageFields({
  block,
  venueId,
  update,
}: {
  block: EditorBlock & { type: "image" };
  venueId: string;
  update: (patch: Partial<CampaignBlock>) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.set("venue_id", venueId);
    fd.set("file", file);
    const r = await uploadCampaignImage(fd);
    setUploading(false);
    if (r.ok) update({ src: r.url });
    else setError(r.message);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      {block.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- external storage URL preview
        <img
          src={block.src}
          alt={block.alt || "Uploaded image"}
          className="max-h-40 w-fit rounded"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          className="text-sm"
          aria-label="Upload image"
        />
        {uploading ? <span className="text-ash text-xs">Uploading…</span> : null}
        {error ? (
          <span role="alert" className="text-xs text-red-600">
            {error}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          value={block.alt}
          onChange={(e) => update({ alt: e.target.value })}
          maxLength={200}
          placeholder="Describe the image (required)"
          className={`${inputCls} flex-[2]`}
        />
        <input
          value={block.href ?? ""}
          onChange={(e) => update({ href: e.target.value.trim() ? e.target.value : undefined })}
          type="url"
          placeholder="Link when tapped (optional, https://…)"
          className={`${inputCls} flex-[2]`}
        />
        <select
          value={block.widthPct}
          onChange={(e) => update({ widthPct: Number(e.target.value) as 25 | 50 | 75 | 100 })}
          className={inputCls}
          aria-label="Image width"
        >
          <option value={100}>Full width</option>
          <option value={75}>75%</option>
          <option value={50}>Half</option>
          <option value={25}>25%</option>
        </select>
      </div>
    </div>
  );
}
