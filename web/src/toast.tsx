/**
 * Toast feedback system (roadmap 8.7: "toast/inline error+success feedback").
 *
 * A tiny React context + hook — no dependency, no portal library. Toasts are rendered by
 * `<ToastViewport />` (mounted once in `App`), stack top-right, auto-dismiss after a few seconds,
 * and are dismissible. Success toasts use `role="status"` (polite) and errors use `role="alert"`
 * (assertive) so assistive tech announces them at the right urgency (prototype.md §8).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  toasts: Toast[];
  /** Push a toast; returns its id so callers can dismiss early if needed. */
  push: (kind: ToastKind, message: string) => number;
  /** Convenience wrappers. */
  success: (message: string) => number;
  error: (message: string) => number;
  info: (message: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a toast stays before auto-dismissing (ms). Errors linger a little longer. */
const DISMISS_MS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 6500,
};

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string): number => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS[kind]);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      push,
      dismiss,
      success: (message: string) => push("success", message),
      error: (message: string) => push("error", message),
      info: (message: string) => push("info", message),
    }),
    [toasts, push, dismiss],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Access the toast API. Must be used under `<ToastProvider>`. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>");
  return ctx;
}
