/**
 * Cancel Scheduled Campaign confirmation modal (roadmap 8.6, prototype.md §6.3).
 *
 * A destructive-action guard: it names the target campaign, explains the two-step cancellation
 * (provider `DELETE` then local "cancelled" + credit release), and only confirms on an explicit
 * click. The confirm button shows an in-flight spinner and stays disabled while cancelling.
 */

import type { Campaign } from "../../types";
import { formatCredits } from "../../lib/format";
import { formatUkDateTime } from "../../lib/time";
import { Button } from "../primitives";
import { Modal } from "../Modal";
import { AlertTriangleIcon } from "../icons";

export interface CancelModalProps {
  campaign: Campaign | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function CancelModal({
  campaign,
  submitting,
  error,
  onClose,
  onConfirm,
}: CancelModalProps): React.JSX.Element {
  return (
    <Modal
      open={campaign !== null}
      onClose={onClose}
      title="Cancel Scheduled Campaign?"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Keep Scheduled
          </Button>
          <Button variant="danger" loading={submitting} onClick={onConfirm}>
            Confirm Cancel
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {campaign ? (
          <p className="text-sm text-slate-700">
            You are about to cancel{" "}
            <span className="font-semibold text-slate-900">{campaign.name}</span>
            {campaign.scheduleDate ? (
              <>
                {" "}
                scheduled for{" "}
                <span className="font-medium">{formatUkDateTime(campaign.scheduleDate)}</span>
              </>
            ) : null}
            . This affects {formatCredits(campaign.estimatedCredits)} of reserved credit.
          </p>
        ) : null}

        <div className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs text-orange-700">
          <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Cancellation safeguard</p>
            <ol className="mt-1 list-inside list-decimal space-y-0.5">
              <li>Deletes the scheduled batch on the SMS provider.</li>
              <li>Marks the campaign cancelled and releases the reserved credits.</li>
            </ol>
            <p className="mt-1">Batches already sent cannot be recalled.</p>
          </div>
        </div>

        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>
    </Modal>
  );
}
