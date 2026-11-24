/**
 * Queued & History panel (roadmap 8.5, prototype.md §5.2).
 *
 * A fixed-height card with an internally scrollable list, split by an accessible tab bar
 * (`role="tablist"` / `role="tab"` / `aria-selected`, prototype.md §8):
 *   - **Queued (Future)** — scheduled/in-flight campaigns with a coverage pill, status pill,
 *     relative dispatch countdown, and a **Cancel Campaign** action.
 *   - **History (Past)** — settled campaigns (sent/cancelled/failed, plus test sends) shown
 *     read-only with their final metrics.
 *
 * Every card renders a message preview (including the opt-out suffix), a 3-metric strip
 * (Valid Recipients / Segments / Total Cost), and a status pill. Nothing is hardcoded.
 */

import { useId } from "react";

import { cx, formatCount, formatCredits } from "../lib/format";
import { analyzeSegments } from "../lib/sms";
import { describeCountdown, formatUkDateTime } from "../lib/time";
import type { Campaign } from "../types";
import { EmptyState, ErrorState, LoadingState, StatusPill } from "./primitives";
import { InboxIcon, TrashIcon } from "./icons";

export type CampaignTab = "queued" | "history";

export interface QueuedHistoryPanelProps {
  activeTab: CampaignTab;
  onTabChange: (tab: CampaignTab) => void;
  queued: Campaign[];
  history: Campaign[];
  queuedLoading: boolean;
  historyLoading: boolean;
  queuedError: string | null;
  historyError: string | null;
  onRetryQueued: () => void;
  onRetryHistory: () => void;
  /** Live balance for the per-card "balance covered" indicator. */
  balance: number | null;
  onRequestCancel: (campaign: Campaign) => void;
}

export function QueuedHistoryPanel({
  activeTab,
  onTabChange,
  queued,
  history,
  queuedLoading,
  historyLoading,
  queuedError,
  historyError,
  onRetryQueued,
  onRetryHistory,
  balance,
  onRequestCancel,
}: QueuedHistoryPanelProps): React.JSX.Element {
  const baseId = useId();
  const queuedTabId = `${baseId}-queued-tab`;
  const historyTabId = `${baseId}-history-tab`;
  const queuedPanelId = `${baseId}-queued-panel`;
  const historyPanelId = `${baseId}-history-panel`;

  const activeList = activeTab === "queued" ? queued : history;
  const activeLoading = activeTab === "queued" ? queuedLoading : historyLoading;
  const activeError = activeTab === "queued" ? queuedError : historyError;
  const activeRetry = activeTab === "queued" ? onRetryQueued : onRetryHistory;

  return (
    <section
      className="flex h-140 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-7 lg:h-180"
      aria-label="Queued and history campaigns"
    >
      {/* Tab bar */}
      <div role="tablist" aria-label="Campaign views" className="flex border-b border-slate-200">
        <TabButton
          id={queuedTabId}
          panelId={queuedPanelId}
          active={activeTab === "queued"}
          onClick={() => onTabChange("queued")}
          label="Queued (Future)"
          count={queued.length}
          countClass="bg-orange-100 text-orange-700"
        />
        <TabButton
          id={historyTabId}
          panelId={historyPanelId}
          active={activeTab === "history"}
          onClick={() => onTabChange("history")}
          label="History (Past)"
          count={history.length}
          countClass="bg-slate-200 text-slate-700"
        />
      </div>

      {/* Scrollable list */}
      <div
        role="tabpanel"
        id={activeTab === "queued" ? queuedPanelId : historyPanelId}
        aria-labelledby={activeTab === "queued" ? queuedTabId : historyTabId}
        className="flex-1 overflow-y-auto p-4"
      >
        {activeLoading && activeList.length === 0 ? (
          <LoadingState label="Loading campaigns…" />
        ) : activeError && activeList.length === 0 ? (
          <ErrorState message={activeError} onRetry={activeRetry} />
        ) : activeList.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="h-5 w-5" />}
            title={activeTab === "queued" ? "Nothing queued" : "No campaigns yet"}
            description={
              activeTab === "queued"
                ? "Scheduled campaigns will appear here with a live dispatch countdown."
                : "Past and test campaigns will appear here once you send one."
            }
          />
        ) : (
          <ul className="space-y-4">
            {activeList.map((campaign) => (
              <li key={campaign.id}>
                {activeTab === "queued" ? (
                  <QueuedCard campaign={campaign} balance={balance} onRequestCancel={onRequestCancel} />
                ) : (
                  <HistoryCard campaign={campaign} />
                )}
              </li>
            ))}
          </ul>
        )}

        {activeError && activeList.length > 0 ? (
          <p className="mt-3 text-center text-xs text-red-600">{activeError}</p>
        ) : null}
      </div>
    </section>
  );
}

function TabButton({
  id,
  panelId,
  active,
  onClick,
  label,
  count,
  countClass,
}: {
  id: string;
  panelId: string;
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  countClass: string;
}): React.JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      onClick={onClick}
      className={cx(
        "flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition",
        active
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-slate-500 hover:text-slate-700",
      )}
    >
      {label}
      <span className={cx("rounded-full px-2 py-0.5 text-xs font-semibold", countClass)}>
        {formatCount(count)}
      </span>
    </button>
  );
}

/** The customer-facing time the campaign already dispatched / will dispatch at. */
function campaignTimestamp(campaign: Campaign): string {
  if (campaign.scheduleDate) return formatUkDateTime(campaign.scheduleDate);
  return formatUkDateTime(campaign.createdAt);
}

function MessagePreview({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="whitespace-pre-wrap wrap-break-word rounded border border-slate-100 bg-slate-50 p-2.5 text-xs text-slate-700">
      {message}
    </p>
  );
}

function MetricStrip({ campaign }: { campaign: Campaign }): React.JSX.Element {
  const segments = analyzeSegments(campaign.message).segments;
  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-100 bg-white p-2.5 text-xs sm:grid-cols-3">
      <Metric label="Valid Recipients" value={formatCount(campaign.totalRecipients)} />
      <Metric label={`Segments (${analyzeSegments(campaign.message).encoding})`} value={String(segments)} />
      <Metric label="Total Cost" value={formatCredits(campaign.estimatedCredits)} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <span className="block text-slate-500">{label}</span>
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function QueuedCard({
  campaign,
  balance,
  onRequestCancel,
}: {
  campaign: Campaign;
  balance: number | null;
  onRequestCancel: (campaign: Campaign) => void;
}): React.JSX.Element {
  const covered = balance === null ? null : campaign.estimatedCredits <= balance;
  const countdown = describeCountdown(campaign.scheduleDate);
  // Only a campaign the server can still cancel exposes the destructive action.
  const cancellable = campaign.status === "QUEUED" || campaign.status === "SCHEDULED";

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900">{campaign.name}</h3>
          <p className="text-xs text-slate-500">{campaignTimestamp(campaign)}</p>
        </div>
        <div className="flex items-center gap-2">
          {covered === null ? null : (
            <span
              className={cx(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                covered
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-red-200 bg-red-50 text-red-700",
              )}
            >
              {covered ? "Balance Covered" : "Insufficient Balance"}
            </span>
          )}
          <StatusPill status={campaign.status} />
        </div>
      </div>

      <div className="mt-3 space-y-3">
        <MessagePreview message={campaign.message} />
        <MetricStrip campaign={campaign} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {countdown ?? (campaign.mode === "IMMEDIATE" ? "Dispatching shortly" : "Awaiting dispatch")}
        </span>
        {cancellable ? (
          <button
            type="button"
            onClick={() => onRequestCancel(campaign)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Cancel Campaign
          </button>
        ) : (
          <span className="text-xs font-medium text-orange-600">Cancelling…</span>
        )}
      </div>
    </article>
  );
}

function HistoryCard({ campaign }: { campaign: Campaign }): React.JSX.Element {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-sm font-semibold text-slate-900">
            {campaign.name}
            {campaign.isTest ? (
              <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                Test
              </span>
            ) : null}
          </h3>
          <p className="text-xs text-slate-500">
            {campaign.mode === "SCHEDULED" && campaign.scheduleDate
              ? `Scheduled for ${campaignTimestamp(campaign)}`
              : `Sent ${campaignTimestamp(campaign)}`}
          </p>
        </div>
        <StatusPill status={campaign.status} />
      </div>

      <div className="mt-3 space-y-3">
        <MessagePreview message={campaign.message} />
        <MetricStrip campaign={campaign} />
      </div>

      {campaign.invalidCount > 0 || campaign.failedBatches > 0 ? (
        <p className="mt-3 text-xs text-red-600">
          {campaign.failedBatches > 0 ? `${formatCount(campaign.failedBatches)} batch(es) failed. ` : ""}
          {campaign.invalidCount > 0 ? `${formatCount(campaign.invalidCount)} number(s) rejected by the provider.` : ""}
        </p>
      ) : null}
    </article>
  );
}
