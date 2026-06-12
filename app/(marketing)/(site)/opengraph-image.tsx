import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/marketing/og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "TableKit — table booking for independent UK hospitality";

export default function Image() {
  return renderOgImage({
    eyebrow: "For independent UK hospitality",
    title: "Fill more tables. Lose fewer to no-shows.",
  });
}
