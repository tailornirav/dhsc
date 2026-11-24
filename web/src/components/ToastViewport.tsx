/**
 * Toast viewport (roadmap 8.7). Renders the toast stack from `useToast()` as a fixed
 * top-right overlay. Success/info toasts use `role="status"` (polite); errors use `role="alert"`
 * (assertive) so screen readers announce them at the right urgency (prototype.md §8).
 */

import { useToast, type Toast } from "../toast";
import { cx } from "../lib/format";
import { AlertTriangleIcon, CheckCircleIcon, CloseIcon } from "./icons";

const KIND_CLASSES: Record<Toast["kind"], string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

function ToastIcon({ kind }: { kind: Toast["kind"] }): React.JSX.Element {
  if (kind === "success") return <CheckCircleIcon className="h-4 w-4" />;
  if (kind === "error") return <AlertTriangleIcon className="h-4 w-4" />;
  return <CheckCircleIcon className="h-4 w-4" />;
}

export function ToastViewport(): React.JSX.Element {
  const { toasts, dismiss } = useToast();

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-4 z-60 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={cx(
            "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-sm",
            KIND_CLASSES[toast.kind],
          )}
        >
          <span className="mt-0.5 shrink-0">
            <ToastIcon kind={toast.kind} />
          </span>
          <p className="flex-1 text-sm">{toast.message}</p>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded p-0.5 opacity-60 transition hover:opacity-100"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
