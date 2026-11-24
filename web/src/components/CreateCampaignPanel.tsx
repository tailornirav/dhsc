/**
 * Create Campaign panel (roadmap 8.4, prototype.md §5.1).
 *
 * Everything the operator needs to draft a blast, with live feedback:
 *   - **Campaign Name** (≤80 chars).
 *   - **Target Audience** is read-only "All Contacts": a sanitization strip shows
 *     `Raw − Opted-Out = Valid Billable` (no dropdown — mission.md §8 delta).
 *   - **Message Body** with a real-time estimator (encoding, characters, segments, recipients,
 *     total cost). The estimator accounts for the opt-out suffix **first**, so it matches the
 *     server's authoritative validation exactly (prototype.md §8).
 *   - **Delivery Schedule**: immediate vs. a UK (`Europe/London`) 15-minute-slot picker.
 *   - **Footer**: Test SMS (opens the modal) and Send/Schedule, both disabled by the guards.
 *
 * The panel is fully controlled: `draft` + `onDraftChange` live in `App` so the Test-SMS modal
 * and the submit handler share one source of truth.
 */

import { useId, useMemo } from "react";

import { cx, formatCount, formatCredits } from "../lib/format";
import {
  MAX_NAME_LENGTH,
  OPT_OUT_SUFFIX,
  analyzeSegments,
  buildFullMessage,
  estimatedCredits,
  messageBudget,
} from "../lib/sms";
import { MIN_LEAD_MINUTES, describeScheduleProblem, nextSlotLocalValue } from "../lib/time";
import { SENDER_ID_CONFIGURED } from "../config";
import { Button } from "./primitives";
import { PhoneIcon, SendIcon } from "./icons";

export interface CampaignDraft {
  name: string;
  message: string;
  mode: "IMMEDIATE" | "SCHEDULED";
  /** `datetime-local` value in UK local time; only meaningful when `mode === "SCHEDULED"`. */
  scheduleLocal: string;
}

/** Fields a validation response can point at (mirrors the server's `ValidationIssue.field`). */
export interface FieldIssues {
  name?: string;
  message?: string;
  scheduleLocal?: string;
}

export interface CreateCampaignPanelProps {
  draft: CampaignDraft;
  onDraftChange: (next: CampaignDraft) => void;
  /** Raw seeded audience total (before opt-outs); from `/api/opt-outs`. */
  rawAudience: number | null;
  /** Current opt-out count; from `/api/opt-outs`. */
  optOutCount: number | null;
  /** Valid billable recipients (raw − opt-outs); from `/api/balance`/`/api/opt-outs`. */
  validRecipients: number | null;
  /** Live balance for the affordability guard; null while unknown. */
  balance: number | null;
  /** Per-field server errors to show inline. */
  fieldIssues: FieldIssues;
  submitting: boolean;
  onOpenTest: () => void;
  onSubmit: () => void;
}

/** Live estimator output — everything the metrics box renders. */
interface EstimatorResult {
  encoding: "GSM-7" | "UCS-2";
  /** Billable length of the full outbound body (body + suffix). */
  used: number;
  /** Max billable length for a single segment under the current encoding. */
  max: number;
  remaining: number;
  segments: number;
  maxBodyLength: number;
  suffixLength: number;
  recipients: number;
  totalCost: number;
  /** True when the body + suffix exceeds a single segment (a hard error server-side). */
  overBudget: boolean;
}

/**
 * Derive the estimator from the draft message + recipient count. Mirrors the worker's
 * `analyzeSegments` / `messageBudget` / `estimatedCredits` so the numbers agree exactly.
 */
export function useEstimator(message: string, recipients: number): EstimatorResult {
  return useMemo(() => {
    const trimmed = message.trim();
    const budget = messageBudget();
    const full = buildFullMessage(trimmed);
    const info = analyzeSegments(full);

    const encoding = info.encoding;
    const max = encoding === "GSM-7" ? 160 : 70;
    const used = info.length;
    const segments = info.segments;

    return {
      encoding,
      used,
      max,
      remaining: max - used,
      segments,
      maxBodyLength: budget.maxBodyLength,
      suffixLength: budget.suffixLength,
      recipients,
      totalCost: estimatedCredits(Math.max(1, segments), recipients),
      // Empty message is not "over budget"; a single-segment overflow is.
      overBudget: trimmed.length > 0 && segments > 1,
    };
  }, [message, recipients]);
}

export function CreateCampaignPanel({
  draft,
  onDraftChange,
  rawAudience,
  optOutCount,
  validRecipients,
  balance,
  fieldIssues,
  submitting,
  onOpenTest,
  onSubmit,
}: CreateCampaignPanelProps): React.JSX.Element {
  const nameId = useId();
  const messageId = useId();
  const scheduleId = useId();
  const radioName = useId();

  const recipients = validRecipients ?? 0;
  const estimator = useEstimator(draft.message, recipients);

  const scheduleProblem =
    draft.mode === "SCHEDULED" && draft.scheduleLocal.trim() !== ""
      ? describeScheduleProblem(draft.scheduleLocal)
      : draft.mode === "SCHEDULED"
        ? "Pick a date and time to schedule."
        : null;

  // Guards (prototype.md §8): block Send/Schedule on empty/invalid input or insufficient money.
  const nameOk = draft.name.trim().length > 0 && draft.name.trim().length <= MAX_NAME_LENGTH;
  const messageOk = draft.message.trim().length > 0 && !estimator.overBudget;
  const scheduleOk = draft.mode === "IMMEDIATE" || scheduleProblem === null;
  const recipientsOk = recipients > 0;
  const affordable = balance === null ? true : estimator.totalCost <= balance;
  const canSubmit =
    nameOk && messageOk && scheduleOk && recipientsOk && affordable && !submitting;

  const update = (patch: Partial<CampaignDraft>) => onDraftChange({ ...draft, ...patch });

  return (
    <section
      className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-5"
      aria-label="Create campaign"
    >
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">Create Campaign</h2>
        <p className="text-xs text-slate-500">Draft and schedule your SMS blast.</p>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* 1. Campaign name */}
        <div>
          <label htmlFor={nameId} className="block text-sm font-medium text-slate-700">
            Campaign Name
          </label>
          <input
            id={nameId}
            type="text"
            maxLength={MAX_NAME_LENGTH}
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="e.g. Weekend Tasting Menu Promo"
            aria-invalid={Boolean(fieldIssues.name)}
            className={cx(
              "mt-1 w-full rounded-lg border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400",
              "focus:outline-none focus:ring-2 focus:ring-blue-500",
              fieldIssues.name ? "border-red-300" : "border-slate-300",
            )}
          />
          <FieldError message={fieldIssues.name} />
        </div>

        {/* 2. Read-only audience with sanitization strip */}
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Target Audience</span>
            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              {formatCount(recipients)} Valid Billable
            </span>
          </div>

          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
            <p className="font-medium text-slate-600">All Contacts (Default)</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-slate-500">Raw: {rawAudience === null ? "—" : formatCount(rawAudience)}</span>
              <span className="text-orange-600">
                −{optOutCount === null ? "—" : formatCount(optOutCount)} Opted-Out
              </span>
              <span className="font-semibold text-emerald-700">
                = {formatCount(recipients)} Valid
              </span>
            </div>
          </div>
        </div>

        {/* 3. Message body + live estimator */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={messageId} className="text-sm font-medium text-slate-700">
              Message Body
            </label>
            <span className="text-right text-xs text-slate-500">
              Max {estimator.maxBodyLength} chars ({estimator.encoding}, −{estimator.suffixLength + 1}{" "}
              for “{OPT_OUT_SUFFIX}”)
            </span>
          </div>
          <textarea
            id={messageId}
            rows={4}
            value={draft.message}
            onChange={(event) => update({ message: event.target.value })}
            placeholder="Write your SMS copy here…"
            aria-invalid={Boolean(fieldIssues.message) || estimator.overBudget}
            className={cx(
              "mt-1 w-full resize-y rounded-lg border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400",
              "focus:outline-none focus:ring-2 focus:ring-blue-500",
              fieldIssues.message || estimator.overBudget ? "border-red-300" : "border-slate-300",
            )}
          />

          {/* Real-time metrics box */}
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <Metric label="Encoding" value={estimator.encoding} />
            <Metric
              label="Characters"
              value={`${estimator.used} / ${estimator.max}${
                estimator.remaining >= 0 ? ` (${estimator.remaining} left)` : ` (${Math.abs(estimator.remaining)} over)`
              }`}
              valueClass={estimator.remaining < 0 ? "text-red-600" : undefined}
            />
            <Metric label="Segments/Msg" value={`${estimator.segments} / 1`} />
            <Metric label="Recipients" value={formatCount(estimator.recipients)} />
            <div className="col-span-2 flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="font-medium text-slate-600">Total Est. Cost</span>
              <span className="text-sm font-bold text-blue-600">
                {formatCredits(estimator.totalCost)}
              </span>
            </div>
          </div>

          {estimator.overBudget ? (
            <p className="mt-1 text-xs text-red-600">
              Message plus the opt-out suffix must fit one segment (max {estimator.maxBodyLength}{" "}
              characters for your text).
            </p>
          ) : null}
          <FieldError message={fieldIssues.message} />
        </div>

        {/* 4. Delivery schedule */}
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Delivery Schedule</legend>
          <div className="mt-2 space-y-2">
            <Radio
              name={radioName}
              checked={draft.mode === "IMMEDIATE"}
              onChange={() => update({ mode: "IMMEDIATE" })}
              label="Send Immediately"
            />
            <Radio
              name={radioName}
              checked={draft.mode === "SCHEDULED"}
              onChange={() =>
                update({
                  mode: "SCHEDULED",
                  // Prefill a valid next slot so the picker never opens on an invalid value.
                  scheduleLocal: draft.scheduleLocal || nextSlotLocalValue(),
                })
              }
              label="Schedule for Later"
            />
          </div>

          {draft.mode === "SCHEDULED" ? (
            <div className="mt-3">
              <label htmlFor={scheduleId} className="block text-sm font-medium text-slate-700">
                Send time (UK)
              </label>
              <input
                id={scheduleId}
                type="datetime-local"
                step={900}
                value={draft.scheduleLocal}
                onChange={(event) => update({ scheduleLocal: event.target.value })}
                aria-invalid={scheduleProblem !== null}
                className={cx(
                  "mt-1 w-full rounded-lg border px-3 py-2 text-sm text-slate-900",
                  "focus:outline-none focus:ring-2 focus:ring-blue-500",
                  scheduleProblem ? "border-red-300" : "border-slate-300",
                )}
              />
              <p className="mt-1 text-xs text-slate-500">
                Timezone: London (GMT/BST) • 15-min intervals • at least {MIN_LEAD_MINUTES} min ahead
              </p>
              <FieldError
                message={
                  fieldIssues.scheduleLocal ??
                  (draft.scheduleLocal.trim() !== "" && scheduleProblem ? scheduleProblem : undefined)
                }
              />
            </div>
          ) : null}
        </fieldset>

        {!SENDER_ID_CONFIGURED ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Sender ID is using the default value. Set <code>VITE_SENDER_ID</code> to the provisioned
            sender ID before deploying.
          </p>
        ) : null}

        {!affordable ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Total estimated cost ({formatCredits(estimator.totalCost)}) exceeds your live balance.
            Top up or reduce the audience.
          </p>
        ) : null}
      </div>

      {/* 5. Footer actions */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 px-5 py-4">
        <Button
          variant="secondary"
          icon={<PhoneIcon className="h-4 w-4" />}
          onClick={onOpenTest}
          disabled={!messageOk}
          title={messageOk ? "Send a test SMS" : "Enter a valid message first"}
        >
          Test SMS
        </Button>
        <Button
          variant="primary"
          loading={submitting}
          icon={<SendIcon className="h-4 w-4" />}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {draft.mode === "SCHEDULED" ? "Schedule" : "Send"}
        </Button>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}): React.JSX.Element {
  return (
    <div>
      <span className="block text-slate-500">{label}</span>
      <span className={cx("font-semibold text-slate-900", valueClass)}>{value}</span>
    </div>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 border-slate-300 text-blue-600 focus:ring-blue-500"
      />
      {label}
    </label>
  );
}

function FieldError({ message }: { message?: string }): React.JSX.Element | null {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-600">{message}</p>;
}
