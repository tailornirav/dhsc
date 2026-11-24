/**
 * Inline SVG icons — a tiny, dependency-free icon set matching the symbols the prototype calls
 * for (paper-plane, shield-off, refresh, wallet, clock, check, phone, trash, close, spinner…).
 *
 * Each icon inherits `currentColor` and sizes from the surrounding font (`1em`), so colour and
 * size are controlled purely with Tailwind utility classes on the element or its parent.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Shared stroke settings for the outline icon family. */
const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SendIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M4 12l16-8-6 16-2.5-6.5L4 12z" />
    </svg>
  );
}

export function ShieldOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
      <path {...strokeProps} d="M9.5 12.5l5-5" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M20 11a8 8 0 1 0-2.3 5.6" />
      <path {...strokeProps} d="M20 5v6h-6" />
    </svg>
  );
}

export function WalletIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <rect {...strokeProps} x="3" y="6" width="18" height="13" rx="2.5" />
      <path {...strokeProps} d="M3 9h18" />
      <circle {...strokeProps} cx="16.5" cy="13.5" r="1.2" />
    </svg>
  );
}

export function ClockIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <circle {...strokeProps} cx="12" cy="12" r="8.5" />
      <path {...strokeProps} d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function CheckCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <circle {...strokeProps} cx="12" cy="12" r="8.5" />
      <path {...strokeProps} d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  );
}

export function AlertTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M12 4l9 15.5H3L12 4z" />
      <path {...strokeProps} d="M12 10v4" />
      <path {...strokeProps} d="M12 17h.01" />
    </svg>
  );
}

export function PhoneIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <rect {...strokeProps} x="7" y="3" width="10" height="18" rx="2.5" />
      <path {...strokeProps} d="M10.5 18h3" />
    </svg>
  );
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M5 7h14" />
      <path {...strokeProps} d="M9 7V5h6v2" />
      <path {...strokeProps} d="M7 7l1 12h8l1-12" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function LogoutIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path {...strokeProps} d="M14 8l4 4-4 4" />
      <path {...strokeProps} d="M18 12H9" />
    </svg>
  );
}

export function InboxIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <path {...strokeProps} d="M4 13l2-8h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z" />
      <path {...strokeProps} d="M4 13h4l1.5 2h5L16 13h4" />
    </svg>
  );
}

/** A small spinning ring for loading states. */
export function SpinnerIcon(props: IconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" className="animate-spin" {...props}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
