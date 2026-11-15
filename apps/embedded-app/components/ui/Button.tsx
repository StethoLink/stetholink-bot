import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "success" | "danger" | "warning";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Shows the busy label and blocks a second press while a request is running. */
  busy?: boolean;
  busyLabel?: string;
}
export const buttonClass = (variant: ButtonVariant = "secondary", size: "md" | "sm" = "md") => `btn btn-${variant}${size === "sm" ? " btn-sm" : ""}`;

export function Button({ variant = "secondary", size = "md", busy = false, busyLabel, className = "", children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`${buttonClass(variant, size)} ${className}`.trim()} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}
