import { HOW_IT_WORKS } from "@/lib/marketing/content";

// How-it-works, three steps. Numbered to make the path feel short and
// low-risk — the point is to defuse "switching is a hassle".

export function Steps() {
  return (
    <ol className="mt-12 grid gap-8 sm:grid-cols-3">
      {HOW_IT_WORKS.map((step) => (
        <li key={step.step} className="flex flex-col gap-3">
          <span className="bg-coral rounded-pill flex size-10 items-center justify-center text-base font-bold text-white">
            {step.step}
          </span>
          <h3 className="text-ink text-lg font-semibold tracking-tight">{step.title}</h3>
          <p className="text-ash text-pretty">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}
