import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/marketing/og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "TableKit pricing — free to start, paid plans from £29 + VAT";

export default function Image() {
  return renderOgImage({
    eyebrow: "Pricing",
    title: "Free to start. Paid from £29 + VAT.",
  });
}
