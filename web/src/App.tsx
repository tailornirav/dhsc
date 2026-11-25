/**
 * Application shell and orchestration (roadmap 8.1–8.7).
 *
 * Composes the sticky header, the Credit Health Monitor, and the two-column workspace, and owns
 * the cross-cutting state that more than one panel needs:
 *   - the live **draft** (shared by the create form, the Test-SMS modal, and submit);
 *   - the **active tab** and which queued campaign is pending cancellation;
 *   - the data hooks (`useBalance`, `useCampaigns` ×2, `useOptOuts`) and their refresh wiring;
 *   - the toast feedback for every async action.
 *
 * The page canvas, container, and responsive split follow prototype.md §2 (5-col create / 7-col
 * panels on `lg`). Polling is enabled only while a campaign is in flight so a Queued card's
 * progress and a CANCELLING campaign settle on their own without a manual refresh.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, createCampaign } from "./api";
import { SENDER_ID } from "./config";
import {
  errorMessage,
  hasInFlightCampaigns,
  requestCancel,
  useBalance,
  useCampaigns,
  useOptOuts,
} from "./hooks";
import { FieldIssuesFromIssues } from "./lib/issues";
import { ToastProvider, useToast } from "./toast";
import type { Campaign } from "./types";
import { CreditHealthMonitor } from "./components/CreditHealthMonitor";
import { Header } from "./components/Header";
import {
  CreateCampaignPanel,
  type CampaignDraft,
  type FieldIssues,
} from "./components/CreateCampaignPanel";
import { QueuedHistoryPanel, type CampaignTab } from "./components/QueuedHistoryPanel";
import { CancelModal } from "./components/modals/CancelModal";
import { OptOutModal } from "./components/modals/OptOutModal";
import { TestSmsModal } from "./components/modals/TestSmsModal";

/** Empty draft — the create form starts clean on every load. */
const EMPTY_DRAFT: CampaignDraft = {
  name: "",
  message: "",
  mode: "IMMEDIATE",
  scheduleLocal: "",
  audienceSource: "all",
  recipients: "",
};

/** Polling cadence while something is in flight (the queue settles batches within seconds). */
const POLL_INTERVAL_MS = 5000;

function Dashboard(): React.JSX.Element {
  const toast = useToast();

  // ---- shared state -------------------------------------------------------------------
  const [draft, setDraft] = useState<CampaignDraft>(EMPTY_DRAFT);
  const [activeTab, setActiveTab] = useState<CampaignTab>("queued");
  const [fieldIssues, setFieldIssues] = useState<FieldIssues>({});
  const [submitting, setSubmitting] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [optOutOpen, setOptOutOpen] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<Campaign | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // ---- data ---------------------------------------------------------------------------
  const balance = useBalance();
  const optOuts = useOptOuts();
  const queued = useCampaigns("upcoming");
  const history = useCampaigns("history");

  const queuedCampaigns = queued.data?.campaigns ?? [];
  const historyCampaigns = history.data?.campaigns ?? [];

  // Poll both lists while any campaign is still in flight so progress self-heals.
  const inFlight =
    hasInFlightCampaigns(queuedCampaigns) || hasInFlightCampaigns(historyCampaigns);
  const pollNow = useCallback(() => {
    queued.refresh();
    history.refresh();
  }, [queued, history]);
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(pollNow, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [inFlight, pollNow]);

  const balanceCredits = balance.data?.balance ?? null;
  const validRecipients = balance.data?.audience_count ?? null;
  const optOutCount = optOuts.data?.count ?? null;
  const rawAudience = useMemo(() => {
    if (optOuts.data?.count == null || optOuts.data.validRecipientCount == null) return null;
    return optOuts.data.validRecipientCount + optOuts.data.count;
  }, [optOuts.data]);

  // The normalised opt-out numbers, so the panel can flag pasted numbers on the blacklist.
  const optOutSet = useMemo(
    () => new Set((optOuts.data?.optOuts ?? []).map((entry) => entry.number)),
    [optOuts.data],
  );

  // ---- actions ------------------------------------------------------------------------
  const refreshAll = useCallback(() => {
    balance.refresh();
    queued.refresh();
    history.refresh();
    optOuts.refresh();
  }, [balance, queued, history, optOuts]);

  const syncBalance = useCallback(() => {
    balance.refresh();
    optOuts.refresh();
  }, [balance, optOuts]);

  const submitCampaign = async () => {
    setFieldIssues({});
    setSubmitting(true);
    try {
      const result = await createCampaign({
        name: draft.name.trim(),
        senderId: SENDER_ID,
        message: draft.message.trim(),
        mode: draft.mode,
        scheduleLocal: draft.mode === "SCHEDULED" ? draft.scheduleLocal : undefined,
        // Only send the pasted list when the operator chose the manual audience source.
        recipients: draft.audienceSource === "manual" ? draft.recipients : undefined,
      });
      toast.success(
        draft.mode === "SCHEDULED"
          ? `“${draft.name.trim()}” scheduled across ${result.totalBatches} chunk(s).`
          : `“${draft.name.trim()}” queued to ${result.totalRecipients.toLocaleString("en-GB")} recipients.`,
      );
      setDraft(EMPTY_DRAFT);
      // Show the operator the tab its campaign landed in.
      setActiveTab(draft.mode === "SCHEDULED" ? "queued" : "history");
      refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.isValidation) {
        setFieldIssues(FieldIssuesFromIssues(error.issues));
        toast.error(error.issues[0]?.message ?? "Please fix the highlighted fields.");
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const confirmCancel = async () => {
    if (!pendingCancel) return;
    setCancelling(true);
    setCancelError(null);
    const outcome = await requestCancel(pendingCancel.id);
    setCancelling(false);
    if (outcome.ok) {
      toast.success(`Cancelling “${pendingCancel.name}”…`);
      setPendingCancel(null);
      refreshAll();
    } else {
      setCancelError(outcome.error);
    }
  };

  // A campaign queued for cancellation can settle out of the list before the operator confirms;
  // in that case the modal just closes rather than acting on a vanished row.
  const pendingCancelLive =
    pendingCancel !== null &&
    (queuedCampaigns.some((c) => c.id === pendingCancel.id) ||
      historyCampaigns.some((c) => c.id === pendingCancel.id));

  return (
    <div className="min-h-screen bg-slate-50 pb-12 font-sans text-slate-900">
      <Header
        optOutCount={optOutCount}
        balanceLoading={balance.refreshing || balance.loading}
        onOpenOptOuts={() => setOptOutOpen(true)}
        onSyncBalance={syncBalance}
      />

      <main className="mx-auto max-w-7xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        <CreditHealthMonitor
          balance={balanceCredits}
          campaigns={queuedCampaigns}
          balanceLoading={balance.refreshing || balance.loading}
          onResync={syncBalance}
        />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <CreateCampaignPanel
            draft={draft}
            onDraftChange={(next) => {
              setDraft(next);
              // Clear stale server errors as soon as the operator edits the draft.
              setFieldIssues((current) => (Object.keys(current).length > 0 ? {} : current));
            }}
            rawAudience={rawAudience}
            optOutCount={optOutCount}
            validRecipients={validRecipients}
            balance={balanceCredits}
            optOutSet={optOutSet}
            fieldIssues={fieldIssues}
            submitting={submitting}
            onOpenTest={() => setTestOpen(true)}
            onSubmit={submitCampaign}
          />

          <QueuedHistoryPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            queued={queuedCampaigns}
            history={historyCampaigns}
            queuedLoading={queued.loading}
            historyLoading={history.loading}
            queuedError={queued.error}
            historyError={history.error}
            onRetryQueued={queued.refresh}
            onRetryHistory={history.refresh}
            balance={balanceCredits}
            onRequestCancel={(campaign) => {
              setCancelError(null);
              setPendingCancel(campaign);
            }}
          />
        </div>
      </main>

      {/* Modals */}
      <TestSmsModal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        senderId={SENDER_ID}
        message={draft.message}
        onSent={(result) => {
          toast.success(`Test SMS queued to ${result.recipient}.`);
          setActiveTab("history");
          refreshAll();
        }}
      />

      <OptOutModal
        open={optOutOpen}
        onClose={() => setOptOutOpen(false)}
        data={optOuts.data}
        loading={optOuts.loading}
        error={optOuts.error}
        onMutated={() => {
          optOuts.refresh();
          balance.refresh();
        }}
        onToast={(kind, message) =>
          kind === "success" ? toast.success(message) : toast.error(message)
        }
      />

      <CancelModal
        campaign={pendingCancelLive ? pendingCancel : null}
        submitting={cancelling}
        error={cancelError}
        onClose={() => {
          if (cancelling) return;
          setPendingCancel(null);
          setCancelError(null);
        }}
        onConfirm={confirmCancel}
      />
    </div>
  );
}

/** Root component: provides the toast context around the dashboard. */
export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
