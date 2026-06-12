// Shared marketing copy that isn't a feature: the problem framing, the
// 3-step how-it-works, and the FAQs. Kept out of JSX so it's easy to edit
// and reuse, and written answer-first so each FAQ answer is a standalone,
// quotable fact (GEO). FAQs also feed FAQPage JSON-LD.

import { PRICING } from "./site";

export type Faq = { q: string; a: string };

export const PROBLEMS = [
  {
    title: "No-shows leave tables empty",
    body: "An empty table at 8pm on a Saturday is money on the floor you can't get back. A deposit or a reminder turns most of them around.",
  },
  {
    title: "Per-cover fees punish success",
    body: "The big platforms charge you for every cover — so the busier you get, the more you pay them for your own regulars. TableKit doesn't.",
  },
  {
    title: "Long contracts lock you in",
    body: "Year-long contracts keep you paying for software you've outgrown. TableKit is month-to-month — stay because it works, not because you're stuck.",
  },
] as const;

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: "Create your free account",
    body: "Add your venue, tables and opening hours. It takes minutes, and you don't need a card to start.",
  },
  {
    step: 2,
    title: "Add booking to your world",
    body: "Drop the widget onto your site or share your branded booking page — on Instagram, Google or a QR code on the table.",
  },
  {
    step: 3,
    title: "Take bookings, stop no-shows",
    body: "Guests book in seconds, everyone gets a confirmation and reminder, and deposits protect your busiest tables.",
  },
] as const;

export const HOME_FAQ: Faq[] = [
  {
    q: "Is there really a free plan?",
    a: `Yes. TableKit is free forever for up to ${PRICING.freeBookingLimit} bookings a month, with no card required to sign up. Paid plans start at £29 + VAT a month when you need more.`,
  },
  {
    q: "How is TableKit different from OpenTable or ResDiary?",
    a: "TableKit charges a flat monthly price with no per-cover fees and no long contracts — typically around a tenth of the cost. Your guests and your data stay yours, and you can leave whenever you like.",
  },
  {
    q: "Do I need a website?",
    a: "No. You get a branded booking page on a single shareable link, so you can take bookings even without a website. If you do have one, the widget drops straight in.",
  },
  {
    q: "Can I move my existing bookings across?",
    a: "Yes. On Plus you can import your bookings and guests from OpenTable, ResDiary or SevenRooms with a guided wizard, so you don't start from scratch.",
  },
  {
    q: "Where is my data stored?",
    a: "In the UK/EU. Guest personal data is encrypted, marketing consent is off by default, and TableKit is built GDPR-first — see our security and privacy pages for detail.",
  },
];

export const PRICING_FAQ: Faq[] = [
  {
    q: `What counts toward the free ${PRICING.freeBookingLimit} bookings a month?`,
    a: `Each confirmed booking counts once. You can take up to ${PRICING.freeBookingLimit} a month on the Free plan; if you regularly need more, Core gives you unlimited bookings for £29 + VAT a month.`,
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Every paid plan is month-to-month with no contract and no cancellation fee. Cancel whenever you like and you keep access until the end of the period you've paid for.",
  },
  {
    q: "Why are prices shown + VAT?",
    a: "Because that's the honest number a VAT-registered operator budgets against. UK VAT is added at checkout via Stripe Tax. List prices are Free, £29 and £74, all excluding VAT.",
  },
  {
    q: "What about SMS and Stripe fees?",
    a: `${PRICING.feesNote} You pay the carrier and Stripe what they charge — TableKit doesn't mark them up.`,
  },
  {
    q: "Can I switch from OpenTable or ResDiary?",
    a: "Yes. Plus includes a guided import from OpenTable, ResDiary and SevenRooms, so you can bring your bookings and guest history with you.",
  },
];
