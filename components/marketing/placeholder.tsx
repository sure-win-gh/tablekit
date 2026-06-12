import { ImageIcon } from "lucide-react";

import { cn } from "@/components/ui";

// A clearly-marked image slot. Until real photography / real-app
// screenshots exist, every visual on the marketing site is one of these —
// captioned with exactly what should go there. We never ship stock that
// misrepresents the product or a faked screenshot.
//
// It reserves its space via an aspect ratio so it can't cause layout
// shift (CLS budget). `caption` is the art-direction note AND the alt
// text intent, so it's announced to assistive tech too.

type Ratio = "16/9" | "4/3" | "1/1" | "3/2";

const RATIO: Record<Ratio, string> = {
  "16/9": "aspect-[16/9]",
  "4/3": "aspect-[4/3]",
  "1/1": "aspect-square",
  "3/2": "aspect-[3/2]",
};

export function Placeholder({
  caption,
  ratio = "16/9",
  className,
}: {
  /** What this image should be, e.g. "Busy café floor, golden hour, real UK venue". */
  caption: string;
  ratio?: Ratio;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={`Placeholder: ${caption}`}
      className={cn(
        "rounded-card border-hairline bg-cloud flex flex-col items-center justify-center gap-2 border border-dashed p-6 text-center",
        RATIO[ratio],
        className,
      )}
    >
      <ImageIcon className="text-stone size-7" aria-hidden />
      <p className="text-ash max-w-xs text-xs font-medium text-pretty">{caption}</p>
    </div>
  );
}
