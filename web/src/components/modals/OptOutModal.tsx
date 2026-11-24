/**
 * Opt-Out Blacklist modal (roadmap 8.6, prototype.md §6.2).
 *
 * Lists the blacklist (scrollable, monospace) with an inline add form. Add/remove call the
 * authenticated `/api/opt-outs` endpoints; both refresh the shared valid-recipient count via the
 * caller's `onMutated`. Numbers are validated/normalised client-side before posting, and duplicates
 * are impossible because the server treats the number as a primary key.
 */

import { useId, useState } from "react";

import { addOptOut, removeOptOut } from "../../api";
import { errorMessage } from "../../hooks";
import { formatCount } from "../../lib/format";
import { normalizeUkMobile } from "../../lib/sms";
import type { OptOutsResponse } from "../../types";
import { EmptyState, ErrorState, LoadingState } from "../primitives";
import { Modal } from "../Modal";
import { PlusIcon } from "../icons";

export interface OptOutModalProps {
  open: boolean;
  onClose: () => void;
  data: OptOutsResponse | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the list + counts after a mutation. */
  onMutated: () => void;
  /** Surface a toast for a successful add/remove. */
  onToast: (kind: "success" | "error", message: string) => void;
}

export function OptOutModal({
  open,
  onClose,
  data,
  loading,
  error,
  onMutated,
  onToast,
}: OptOutModalProps): React.JSX.Element {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const normalized = normalizeUkMobile(draft);
  const list = data?.optOuts ?? [];

  const close = () => {
    if (busy) return;
    setDraft("");
    setInlineError(null);
    onClose();
  };

  const submitAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (normalized === null) {
      setInlineError("Enter a valid UK mobile number.");
      return;
    }
    setBusy(true);
    setInlineError(null);
    try {
      const result = await addOptOut(normalized);
      onMutated();
      onToast(
        "success",
        result.added ? `${result.number} added to the opt-out list.` : `${result.number} was already opted out.`,
      );
      setDraft("");
    } catch (err) {
      setInlineError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRemove = async (number: string) => {
    setRemoving(number);
    try {
      await removeOptOut(number);
      onMutated();
      onToast("success", `${number} removed from the opt-out list.`);
    } catch (err) {
      onToast("error", errorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Opt-Out Blacklist"
      maxWidthClass="max-w-lg"
      dismissible={!busy}
      footer={
        <button
          type="button"
          onClick={close}
          className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Close
        </button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Numbers listed here are automatically stripped from all campaign audiences.
        </p>

        {/* Inline add form */}
        <form onSubmit={submitAdd} className="flex items-start gap-2">
          <div className="flex-1">
            <label htmlFor={inputId} className="sr-only">
              Phone number to opt out
            </label>
            <input
              id={inputId}
              type="tel"
              inputMode="tel"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="+447700900077"
              aria-invalid={draft.length > 0 && normalized === null}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={busy || normalized === null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            Add
          </button>
        </form>
        {inlineError ? <p className="text-xs text-red-600">{inlineError}</p> : null}

        {/* List */}
        <div className="rounded-lg border border-slate-200">
          {loading && !data ? (
            <LoadingState label="Loading opt-outs…" />
          ) : error && !data ? (
            <ErrorState message={error} />
          ) : list.length === 0 ? (
            <EmptyState
              title="No opt-outs"
              description="Numbers you add will be stripped from every campaign."
            />
          ) : (
            <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto">
              {list.map((entry) => (
                <li
                  key={entry.number}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="font-mono text-sm text-slate-700">{entry.number}</span>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-700">
                      Opted Out
                    </span>
                    <button
                      type="button"
                      onClick={() => submitRemove(entry.number)}
                      disabled={removing === entry.number}
                      className="text-xs font-medium text-slate-500 underline-offset-2 transition hover:text-red-600 hover:underline disabled:opacity-50"
                    >
                      {removing === entry.number ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {data ? (
          <p className="text-xs text-slate-500">
            {formatCount(data.count)} opted out · {formatCount(data.validRecipientCount)} valid
            recipients remaining.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
