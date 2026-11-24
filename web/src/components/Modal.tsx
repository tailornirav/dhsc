/**
 * Accessible modal primitive (roadmap 8.6, prototype.md §6/§8).
 *
 * Implements the full dialogue contract the prototype asks for:
 *   - `role="dialog"` + `aria-modal="true"` and an `aria-labelledby` pointing at the title;
 *   - **Escape** dismisses (unless a request is in flight and `dismissible` is false);
 *   - a dimmed backdrop that also dismisses on click (same guard);
 *   - **focus trapping**: focus moves into the dialog on open and Tab cycles within it;
 *   - focus is restored to the previously-active element on close.
 *
 * Rendering to `document.body` via a portal keeps the dialog out of any transformed/overflow
 * ancestor (the fixed-height panels use `overflow`), so it is never clipped.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "../lib/format";
import { CloseIcon } from "./icons";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Footer actions (buttons). Rendered in a bordered action bar. */
  footer?: ReactNode;
  /** When false, Escape/backdrop clicks are ignored (e.g. an in-flight submit). Default true. */
  dismissible?: boolean;
  /** Tailwind max-width class for the panel. Defaults to a comfortable form width. */
  maxWidthClass?: string;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  dismissible = true,
  maxWidthClass = "max-w-md",
}: ModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Remember what had focus before opening so we can restore it on close.
  const restoreRef = useRef<HTMLElement | null>(null);

  // Escape to close + lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, dismissible, onClose]);

  // Move focus into the dialog once it is mounted.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [open]);

  if (!open) return null;

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.offsetParent !== null,
    );
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      {/* Dimmed backdrop */}
      <div className="absolute inset-0 bg-slate-900/50" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onPanelKeyDown}
        className={cx(
          "relative z-10 w-full rounded-xl border border-slate-200 bg-white shadow-xl",
          maxWidthClass,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
