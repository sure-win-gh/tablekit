import type { ReactNode } from "react";

import { cn } from "./cn";

// Form-field wrapper: label above, control in the middle, helper /
// error text below. Pass the control as `children`; Field doesn't
// inject styling onto it. Generates an htmlFor → id link automatically
// when `htmlFor` is supplied.

type FieldProps = {
  label: string;
  htmlFor?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  optional?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
};

export function Field({ label, htmlFor, hint, error, optional, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-ink flex items-baseline justify-between text-xs font-semibold"
      >
        <span>{label}</span>
        {optional ? <span className="text-ash text-[11px] font-medium">Optional</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-rose text-[11px]">{error}</p>
      ) : hint ? (
        <p className="text-ash text-[11px]">{hint}</p>
      ) : null}
    </div>
  );
}
