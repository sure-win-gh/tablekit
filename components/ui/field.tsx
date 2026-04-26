import type { ReactNode } from "react";

import { cn } from "./cn";

// Form-field wrapper: label above, control in the middle, helper /
// error text below. Pass the control as `children`; Field doesn't
// inject styling onto it. Generates an htmlFor → id link automatically
// when `htmlFor` is supplied.

type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  className?: string;
  children: ReactNode;
};

export function Field({ label, htmlFor, hint, error, optional, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-baseline justify-between text-xs font-semibold text-ink"
      >
        <span>{label}</span>
        {optional ? <span className="text-[11px] font-medium text-ash">Optional</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-[11px] text-rose">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-ash">{hint}</p>
      ) : null}
    </div>
  );
}
