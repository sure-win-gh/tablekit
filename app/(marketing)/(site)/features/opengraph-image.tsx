import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/marketing/og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "TableKit features — everything you need to run the floor";

export default function Image() {
  return renderOgImage({
    eyebrow: "Features",
    title: "Everything you need to run the floor.",
  });
}
