import { forwardRef } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "./cn";

// Three sibling form-control primitives sharing the same chrome:
// Input (text/email/etc), Select (native dropdown), Textarea. The
// hairline border switches to ink on focus + adds a 2px ink ring,
// matching Airbnb's input pattern. Errors surface via the `invalid`
// prop — Field handles wiring this from validation state.

type Size = "sm" | "md";

type Common = {
  invalid?: boolean;
  size?: Size;
};

const SIZE_INPUT: Record<Size, string> = {
  sm: "h-7 px-2 text-xs",
  md: "h-9 px-3 text-sm",
};

function controlClasses(invalid: boolean | undefined, size: Size): string {
  return cn(
    "w-full rounded-input border bg-white text-ink transition",
    "placeholder:text-mute",
    "focus:outline-none focus:ring-2 focus:ring-offset-0",
    invalid
      ? "border-rose focus:border-rose focus:ring-rose"
      : "border-hairline focus:border-ink focus:ring-ink",
    "disabled:cursor-not-allowed disabled:bg-cloud disabled:text-ash",
    SIZE_INPUT[size],
  );
}

// Omit native `size` (column width number) so our visual `size`
// "sm" | "md" doesn't collide with the HTML attribute typing.
type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & Common;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, size, className, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(controlClasses(invalid, size ?? "md"), className)}
      {...rest}
    />
  );
});

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & Common;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, size, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(controlClasses(invalid, size ?? "md"), className)}
      {...rest}
    >
      {children}
    </select>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "w-full rounded-input border bg-white px-3 py-2 text-sm text-ink transition",
        "placeholder:text-mute",
        "focus:outline-none focus:ring-2 focus:ring-offset-0",
        invalid
          ? "border-rose focus:border-rose focus:ring-rose"
          : "border-hairline focus:border-ink focus:ring-ink",
        "disabled:cursor-not-allowed disabled:bg-cloud disabled:text-ash",
        className,
      )}
      {...rest}
    />
  );
});
