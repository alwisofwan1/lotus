"use client";
import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

/**
 * The one button. Four variants × two sizes, plus `icon` for a square glyph-only button
 * (which then needs an `aria-label`). Skin: `.ui-btn` in styles/ui-kit.css, app palette only.
 *
 * primary   — the single main action of a row or dialog
 * secondary — any other action (default)
 * ghost     — low-emphasis or toolbar action
 * danger    — destructive action
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", icon, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn("ui-btn", className)}
      data-variant={variant}
      data-size={size}
      data-icon={icon ? "" : undefined}
      {...props}
    />
  ),
);

Button.displayName = "Button";
