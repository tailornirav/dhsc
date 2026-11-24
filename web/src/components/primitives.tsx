/**
 * Small shared UI primitives: buttons, status pills, spinners, and empty states. Kept here (not
 * in a component library) so the whole visual system lives in the repo with no extra dependency
 * (hard rule #1: Cloudflare only, $0).
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "../lib/format";
import type { CampaignStatus } from "../types";
import { InboxIcon, SpinnerIcon } from "./icons";

// ---------------------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "soft" | "danger" | "dark";
type Size = "sm" | "md";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 border border-blue-600",
  secondary: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50",
  soft: "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100",
  danger: "bg-red-600 text-white border border-red-600 hover:bg-red-700",
  dark: "bg-slate-900 text-white border border-slate-900 hover:bg-slate-800",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "text-xs px-2.5 py-1.5 gap-1.5",
  md: "text-sm px-3.5 py-2 gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Show a leading spinner and disable interaction (async in-flight state). */
  loading?: boolean;
  /** Optional leading icon. */
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <SpinnerIcon className="h-3.5 w-3.5" /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------------------

/** Tailwind classes per campaign status (prototype.md §5.2 palette). */
const STATUS_CLASSES: Record<CampaignStatus, string> = {
  QUEUED: "bg-blue-50 text-blue-700 border-blue-200",
  PROCESSING: "bg-blue-50 text-blue-700 border-blue-200",
  SENT: "bg-green-50 text-green-700 border-green-200",
  SCHEDULED: "bg-orange-50 text-orange-700 border-orange-200",
  CANCELLING: "bg-orange-50 text-orange-700 border-orange-200",
  CANCELLED: "bg-slate-100 text-slate-600 border-slate-200",
  PARTIAL_FAILURE: "bg-red-50 text-red-700 border-red-200",
};

/** Human label for a status (title-case, `PARTIAL_FAILURE` → `Partial failure`). */
export function statusLabel(status: CampaignStatus): string {
  switch (status) {
    case "PARTIAL_FAILURE":
      return "Partial failure";
    case "QUEUED":
      return "Queued";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase();
  }
}

export function StatusPill({ status }: { status: CampaignStatus }): React.JSX.Element {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status],
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? <InboxIcon className="h-5 w-5" />}
      </div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="max-w-xs text-xs text-slate-500">{description}</p> : null}
    </div>
  );
}

/** Centered spinner + label used while a panel's first load is in flight. */
export function LoadingState({ label = "Loading…" }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-slate-500">
      <SpinnerIcon className="h-4 w-4" />
      {label}
    </div>
  );
}

/** Inline error block for a failed panel load, with an optional retry button. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="text-sm text-red-600">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
