/**
 * Credit Health Monitor (roadmap 8.3, prototype.md §4).
 *
 * Sits above the workspace and answers one question at a glance: *can we afford what we have
 * queued?* It shows three KPIs —
 *   - **Live API Balance** — from `GET /api/balance` (the provider's number);
 *   - **Reserved Credits** — the sum of `estimatedCredits` across in-flight campaigns (what the
 *     queued/scheduled blasts have already earmarked);
 *   - **Effective Available** — `balance − reserved`, highlighted red when negative.
 *
 * A **deficit banner** appears only when `reserved > balance`, telling the operator to top up or
 * cancel queued blasts (prototype.md §4). Nothing here is hardcoded (prototype.md §8).
 */

import { cx, formatCredits } from "../lib/format";
import type { Campaign } from "../types";
import { Button } from "./primitives";
import { AlertTriangleIcon, CheckCircleIcon, ClockIcon, WalletIcon } from "./icons";

/** Credits reserved by a campaign — only in-flight ones hold a reservation. */
function reservedCredits(campaigns: Campaign[]): number {
  return campaigns
    .filter((c) => c.status === "QUEUED" || c.status === "PROCESSING" || c.status === "SCHEDULED")
    .reduce((sum, c) => sum + c.estimatedCredits, 0);
}

export interface CreditHealthMonitorProps {
  /** Live provider balance, or null while unknown/unavailable. */
  balance: number | null;
  /** In-flight campaigns (Queued tab) whose credits are reserved. */
  campaigns: Campaign[];
  balanceLoading: boolean;
  onResync: () => void;
}

export function CreditHealthMonitor({
  balance,
  campaigns,
  balanceLoading,
  onResync,
}: CreditHealthMonitorProps): React.JSX.Element {
  const reserved = reservedCredits(campaigns);
  const hasBalance = balance !== null;
  const effective = hasBalance ? balance - reserved : null;
  const deficit = hasBalance && reserved > balance;

  return (
    <section className="space-y-4" aria-label="Credit health">
      {deficit ? (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">Credit Deficit Warning</p>
              <p className="text-xs text-red-600">
                Your queued campaigns have reserved more credits than your live balance covers. Top
                up in the provider dashboard, or cancel a queued blast to release its reservation.
              </p>
            </div>
          </div>
          <Button variant="danger" size="sm" loading={balanceLoading} onClick={onResync}>
            Re-Sync Live Balance
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KpiCard
          label="Live API Balance"
          value={hasBalance ? formatCredits(balance) : "—"}
          iconClass="bg-blue-50 text-blue-600"
          icon={<WalletIcon className="h-5 w-5" />}
          loading={balanceLoading && !hasBalance}
        />
        <KpiCard
          label="Reserved Credits"
          value={formatCredits(reserved)}
          hint={reserved > 0 ? "Held by queued/scheduled campaigns" : "Nothing queued"}
          iconClass="bg-orange-50 text-orange-600"
          icon={<ClockIcon className="h-5 w-5" />}
        />
        <KpiCard
          label="Effective Available"
          value={effective !== null ? formatCredits(effective) : "—"}
          hint={effective !== null && effective < 0 ? "Over-committed" : "Net spendable credits"}
          iconClass={effective !== null && effective < 0 ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}
          icon={<CheckCircleIcon className="h-5 w-5" />}
          valueClass={effective !== null && effective < 0 ? "text-red-600" : undefined}
        />
      </div>
    </section>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  iconClass,
  valueClass,
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  iconClass: string;
  valueClass?: string;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p className={cx("mt-1 truncate text-2xl font-bold text-slate-900", valueClass)}>
          {loading ? "…" : value}
        </p>
        {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
      </div>
      <div className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", iconClass)}>
        {icon}
      </div>
    </div>
  );
}
