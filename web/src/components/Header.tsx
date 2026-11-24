/**
 * Sticky top navigation header (roadmap 8.2, prototype.md §3).
 *
 * Left cluster: brand badge + title/subtitle.
 * Right cluster: Opt-Outs (count) button, Sync Balance button, environment pill, Sign Out.
 *
 * The prototype removed the Sign Out button, but tech.md §10 explicitly restores it ("Auth is
 * back … add a Sign Out affordance"). A **Sign Out** control here links to Cloudflare Access's
 * logout endpoint, which is what actually ends the Zero Trust session — the Worker never handles
 * credentials itself (tech.md §9.1).
 */

import { cx, formatCount } from "../lib/format";
import { ENVIRONMENT_LABEL } from "../config";
import { Button } from "./primitives";
import { LogoutIcon, RefreshIcon, SendIcon, ShieldOffIcon } from "./icons";

export interface HeaderProps {
  optOutCount: number | null;
  balanceLoading: boolean;
  onOpenOptOuts: () => void;
  onSyncBalance: () => void;
}

/**
 * Cloudflare Access logout URL. Access exposes this per-application; the safest cross-deploy
 * default is the Access logout path on the same host, which clears the session cookie. We keep
 * it relative so it follows the deploy domain (dhsc.uk).
 */
const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export function Header({
  optOutCount,
  balanceLoading,
  onOpenOptOuts,
  onSyncBalance,
}: HeaderProps): React.JSX.Element {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        {/* Brand cluster */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
            <SendIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight text-slate-900 sm:text-xl">
              Dilli Haat SMS Campaign (DHSC)
            </h1>
            <p className="hidden text-xs text-slate-500 sm:block">Bulk SMS Campaign Manager</p>
          </div>
        </div>

        {/* Action cluster */}
        <div className="flex items-center gap-2 sm:gap-3">
          <Button
            variant="secondary"
            size="sm"
            icon={<ShieldOffIcon className="h-4 w-4 text-orange-500" />}
            onClick={onOpenOptOuts}
            title="Manage the opt-out blacklist"
          >
            Opt-Outs{optOutCount === null ? "" : ` (${formatCount(optOutCount)})`}
          </Button>

          <Button
            variant="soft"
            size="sm"
            loading={balanceLoading}
            icon={<RefreshIcon className="h-4 w-4" />}
            onClick={onSyncBalance}
            title="Fetch the live provider balance"
          >
            Sync Balance
          </Button>

          <span
            className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 sm:inline-flex"
            title={`Runtime: ${ENVIRONMENT_LABEL}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            {ENVIRONMENT_LABEL}
          </span>

          <a
            href={ACCESS_LOGOUT_PATH}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5",
              "text-xs font-medium text-slate-700 transition hover:bg-slate-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
            )}
            title="Sign out of the dashboard"
          >
            <LogoutIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Sign Out</span>
          </a>
        </div>
      </div>
    </header>
  );
}
