/**
 * Send Test SMS modal (roadmap 8.6, prototype.md §6.1).
 *
 * Shows a draft summary (encoding + segment count) and takes a UK number, then posts to
 * `/api/test-sms`. The number is validated/normalised client-side first (mirrors the server) so
 * an obviously bad value never costs a round trip, and the send button is disabled while in flight.
 * The server still records the test in History (`is_test = 1`) and reports the real outcome, which
 * the caller surfaces as a toast.
 */

import { useId, useState } from "react";

import { analyzeSegments, normalizeUkMobile } from "../../lib/sms";
import { ApiError, sendTestSms } from "../../api";
import { errorMessage } from "../../hooks";
import type { TestSmsResponse } from "../../types";
import { Button } from "../primitives";
import { Modal } from "../Modal";

export interface TestSmsModalProps {
  open: boolean;
  onClose: () => void;
  /** The sender ID posted with the test. */
  senderId: string;
  /** The current draft message (without the suffix; the server appends it). */
  message: string;
  /** Called on a successful `202` so the caller can toast + refresh History. */
  onSent: (result: TestSmsResponse) => void;
}

export function TestSmsModal({
  open,
  onClose,
  senderId,
  message,
  onSent,
}: TestSmsModalProps): React.JSX.Element {
  const numberId = useId();
  const [number, setNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = message.trim();
  const info = analyzeSegments(trimmed);
  const normalized = normalizeUkMobile(number);
  const canSend = trimmed.length > 0 && normalized !== null && !submitting;

  const close = () => {
    if (submitting) return;
    setNumber("");
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!canSend || normalized === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendTestSms({ senderId, message: trimmed, to: normalized });
      onSent(result);
      setNumber("");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.isValidation) {
        setError(err.issues[0]?.message ?? err.message);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Send Test SMS"
      dismissible={!submitting}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="dark" loading={submitting} disabled={!canSend} onClick={submit}>
            Send Test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <p className="font-medium text-slate-700">Draft</p>
          <p className="mt-1">
            {info.segments === 0 ? "Empty message" : `${info.segments} segment · ${info.encoding}`}
          </p>
          {trimmed ? (
            <p className="mt-1 whitespace-pre-wrap wrap-break-word text-slate-500">{trimmed}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor={numberId} className="block text-sm font-medium text-slate-700">
            Test Phone Number (UK +44)
          </label>
          <input
            id={numberId}
            type="tel"
            inputMode="tel"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            placeholder="+447700900077"
            aria-invalid={number.length > 0 && normalized === null}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {number.length > 0 && normalized === null ? (
            <p className="mt-1 text-xs text-red-600">Enter a valid UK mobile number.</p>
          ) : null}
        </div>

        {error ? <p className="text-xs text-red-600">{error}</p> : null}
      </div>
    </Modal>
  );
}
