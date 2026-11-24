/**
 * Data hooks — the read layer the dashboard sits on.
 *
 * One hook per resource keeps loading/error/refresh handling in a single place instead of being
 * sprinkled through components (prototype.md §8: "Bind balances … to live state"). Each hook:
 *   - exposes `data`, `loading`, `error`,
 *   - exposes a `refresh()` the toolbar buttons (Sync Balance) can call,
 *   - never throws — a failure lands in `error` so the panel can show an inline state.
 *
 * `useCampaigns` additionally polls while any campaign is still in flight, so a Queued card's
 * progress and a CANCELLING campaign settle without a manual refresh (Phase 9 relies on this).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchBalance,
  fetchCampaigns,
  fetchOptOuts,
  cancelCampaign,
  type ApiError,
} from "./api";
import type { BalanceResponse, Campaign, OptOutsResponse } from "./types";

/** Generic async-state container returned by every data hook. */
export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  /** True during a background refresh when `data` is already present (avoid flashing loaders). */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/** Human-readable message for any thrown value (ApiError, Error, or unknown). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Shared hook plumbing: run `load`, track state, expose a stable `refresh`. */
function useAsyncResource<T>(load: () => Promise<T>, deps: unknown[], pollMs?: number): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hadData = data !== null;
    if (hadData) setRefreshing(true);
    else setLoading(true);

    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep any previously-loaded data on a failed background refresh; only surface the error.
        setError(errorMessage(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Optional polling: re-run the load on an interval (used while campaigns are in flight).
  useEffect(() => {
    if (!pollMs) return;
    const id = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  return { data, loading, refreshing, error, refresh };
}

/** Live credit balance + current valid audience size (`GET /api/balance`). */
export function useBalance(): AsyncState<BalanceResponse> {
  return useAsyncResource(() => fetchBalance(), []);
}

/** The opt-out blacklist and its effect on the valid recipient count (`GET /api/opt-outs`). */
export function useOptOuts(): AsyncState<OptOutsResponse> {
  return useAsyncResource(() => fetchOptOuts(), []);
}

/** Campaigns for one tab (`upcoming` = Queued, `history` = History). */
export function useCampaigns(
  filter: "upcoming" | "history",
  options: { pollMs?: number } = {},
): AsyncState<CampaignListResponseLike> {
  return useAsyncResource(() => fetchCampaigns(filter), [filter], options.pollMs);
}

/** Local alias so the hook signature stays readable without importing the response type name twice. */
type CampaignListResponseLike = { filter: "upcoming" | "history"; campaigns: Campaign[] };

/**
 * True when any campaign is still in flight and worth polling for. Used to decide the poll
 * interval: we only hammer the API while something can actually change.
 */
export function hasInFlightCampaigns(campaigns: Campaign[]): boolean {
  return campaigns.some(
    (c) =>
      c.status === "QUEUED" ||
      c.status === "PROCESSING" ||
      c.status === "SCHEDULED" ||
      c.status === "CANCELLING",
  );
}

/**
 * Cancel a campaign. Returns `{ ok }` and never throws, so the modal can show an inline error.
 */
export async function requestCancel(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await cancelCampaign(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Type guard to narrow a caught value to `ApiError` without importing the class everywhere. */
export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}
