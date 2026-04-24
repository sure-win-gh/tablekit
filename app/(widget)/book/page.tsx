// Bare `/book` has no venue context — visitors should have followed a
// per-venue link (`/book/<venueId>`). Render a helpful stub rather
// than a 404 so a mistyped URL gives a human message.

export default function BookIndexPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Book a table</h1>
      <p className="text-sm text-neutral-500">
        Please follow the booking link your venue sent you, or use the booking button on their
        website. The link looks like <span className="font-mono">/book/&lt;venue-id&gt;</span>.
      </p>
    </main>
  );
}
