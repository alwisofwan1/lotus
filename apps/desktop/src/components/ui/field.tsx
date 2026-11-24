"use client";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Text input on the shared field well (`.ui-field`). `mono` for paths, keys and commands. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  ({ className, mono, ...props }, ref) => (
    <input ref={ref} className={cn("ui-field", className)} data-mono={mono ? "" : undefined} {...props} />
  ),
);
Input.displayName = "Input";

/** Multi-line text on the same field well. `filled` drops the outline for a quiet, filled well. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { /** Borderless filled well, for a dialog's main field. */ filled?: boolean }
>(({ className, filled, ...props }, ref) => (
  <textarea ref={ref} className={cn("ui-field", className)} data-filled={filled ? "" : undefined} {...props} />
));
Textarea.displayName = "Textarea";

interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  /** Accessible name. */
  label: string;
}

/** Native <select> on the shared field well, with the up/down glyph. */
export function Select<T extends string>({ value, onChange, options, label, className, style, ...props }: SelectProps<T>) {
  return (
    <span className={cn("ui-select", className)} style={style}>
      <select aria-label={label} className="ui-field" value={value} onChange={(e) => onChange(e.target.value as T)} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronsUpDown size={12} aria-hidden />
    </span>
  );
}
