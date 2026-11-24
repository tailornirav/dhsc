# Dilli Haat SMS Campaign (DHSC) — Web App UI Reference & AI Assistant Guide

> **Working Baseline Notice (Not Final Truth):**  
> Treat this document as a directional UI and structural reference—**not** a rigid, unchangeable specification. Feel free to adapt component architecture, state management, validation rules, error boundaries, loading indicators, responsive breakpoints, and API bindings as backend contracts and product requirements evolve.

---

## 1. Key Adjustments from the Initial HTML Prototype

Before building, apply these explicit scope changes over the reference prototype:

1. **No Login Gate:** Remove the unauthenticated Login Gate view completely. The application opens directly into the Main Dashboard workspace. Also omit the **Sign Out** button from the top navigation header (only re-introduce authentication UI if an auth layer is explicitly added later).
2. **Default All Contacts (No Audience Dropdown):** Remove the Target Audience `<select>` dropdown (`All Contacts`, `Random Contacts Subset`, `Top Frequent Visitors`) and the conditional `Number of Contacts` input. Every campaign automatically targets **All Contacts** (after stripping opt-outs), displayed via a read-only audience summary and sanitization strip.

---

## 2. Visual System & Layout Shell

* **Styling:** Tailwind CSS utility classes (or equivalent design tokens).
* **Page Canvas:** `min-h-screen bg-slate-50 text-slate-900 font-sans pb-12`.
* **Container:** Centered workspace (`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`).
* **Card Surfaces:** `bg-white rounded-xl border border-slate-200 shadow-sm`.
* **Semantic Palette:**
  * **Primary / Interactive:** `blue-600` (hover `blue-700`), soft accents `blue-50` / `blue-200` / `blue-700`.
  * **Valid / Sent / Production:** `emerald-50` / `emerald-200` / `emerald-700` and `green-50` / `green-100` / `green-700`.
  * **Reserved / Scheduled / Opt-Out:** `orange-50` / `orange-100` / `orange-600` / `orange-700`.
  * **Destructive / Deficit / Error:** `red-50` / `red-200` / `red-600` / `red-700`.
  * **Neutral Surfaces & Text:** `slate-50` through `slate-900`.
* **Responsive Breakpoints:**
  * Mobile (default): Single-column vertical stack.
  * Tablet (`md:`): 3-column horizontal KPI strip.
  * Desktop (`lg:`): 12-column workspace split into a **5-column** left panel (Create Campaign) and a **7-column** right panel (Queued & History).

---

## 3. Top Navigation Header (Sticky)

Sticky full-width header (`bg-white border-b border-slate-200 sticky top-0 z-20`).

* **Left Brand Cluster:**
  * **Logo Badge:** `bg-blue-600 p-2 rounded-lg text-white` containing a paper-plane/send icon.
  * **Title:** `Dilli Haat SMS Campaign (DHSC)` (`text-xl font-bold tracking-tight`).
  * **Subtitle:** `Bulk SMS Campaign Manager` (`text-xs text-slate-500 hidden sm:block`).
* **Right Action Cluster:**
  * **Opt-Outs (`N`) Button:** White bordered button with an orange shield-off icon and dynamic blacklist count (e.g., `Opt-Outs (12)`). Opens the **Opt-Out Blacklist Modal**.
  * **Sync Balance Button:** Soft blue button (`bg-blue-50 border-blue-200 text-blue-700`) with a refresh icon. Triggers a live balance fetch from the SMS provider.
  * **Environment Pill:** Non-interactive status indicator (`bg-emerald-50 border-emerald-200 text-emerald-700 rounded-full`) with a status dot and runtime label (e.g., `Production` or `Sandbox`).
  * *(Omitted: Sign Out button.)*

---

## 4. Credit Health Monitor

Located at the top of `<main>` above the 2-column workspace.

### Conditional Credit Deficit Banner
* **Condition:** Display only when `reservedCredits > liveApiBalance`.
* **Appearance:** `bg-red-50 border border-red-200 rounded-xl text-red-700`.
* **Content:** Heading `Credit Deficit Warning`, explanatory text advising the operator to top up or cancel queued blasts, and a `Re-Sync Live Balance` button (`bg-red-600 text-white`).

### 3-Column KPI Strip (`grid-cols-1 md:grid-cols-3 gap-4`)

| Card Label | Icon & Accent | Purpose / Calculation |
| :--- | :--- | :--- |
| **Live API Balance** | Blue wallet (`bg-blue-50 text-blue-600`) | Current live credit balance returned by the SMS provider API. |
| **Reserved Credits** | Orange clock (`bg-orange-50 text-orange-600`) | Sum of credits reserved across all currently queued/scheduled campaigns. |
| **Effective Available** | Green check (`bg-green-50 text-green-600`) | Net spendable credits: `liveApiBalance - reservedCredits` (highlight in red if negative). |

---

## 5. Main 2-Column Workspace (`grid-cols-1 lg:grid-cols-12 gap-8`)

### 5.1 Left Column — Create Campaign (`lg:col-span-5`)

White card with a subtle header (`Create Campaign` / `Draft and schedule your SMS blast.`), scrollable form body, and sticky-style footer action bar.

1. **Campaign Name**
   * `<input type="text" maxlength="80">`
   * Placeholder: `e.g. Weekend Tasting Menu Promo`
2. **Target Audience (Read-Only Default: All Contacts)**
   * Header row with label `Target Audience` and right-aligned pill badge showing live billable count (e.g., `1,238 Valid Billable`).
   * Static/read-only badge or container indicating `All Contacts (Default)` — **no dropdown selector and no contact count subset field**.
   * **Sanitization Summary Strip** (`bg-slate-50 border border-slate-200 rounded-lg text-xs`):
     * `Raw: 1,250`
     * `-12 Opted-Out` (`text-orange-600`)
     * `= 1,238 Valid` (`text-emerald-700 font-semibold`)
3. **Message Body & Real-Time Estimator**
   * Header row with label `Message Body` and helper text noting segment budget (e.g., `Max 160 chars (1 segment, -16 for "Stop: dhsc.uk/x")`, dynamically adjusted if UCS-2/multi-segment is supported).
   * `<textarea>` for SMS copy.
   * **Real-Time Metrics Box** (`bg-slate-50 border border-slate-200 rounded-lg p-3 grid grid-cols-2`):
     * `Encoding`: `GSM-7` (or `UCS-2` when non-GSM characters/emojis are detected)
     * `Characters`: `used / max (remaining left)`
     * `Segments/Msg`: `current / maxAllowed`
     * `Recipients`: Valid billable contact count
     * `Total Est. Cost` (full-width bottom row): `recipients * segments` in bold `text-blue-600` (e.g., `1,238 credits`)
4. **Delivery Schedule**
   * Radio group (`name="schedule"`):
     * `Send Immediately` (default)
     * `Schedule for Later`
   * **Conditional Date/Time Picker:** Visible only when `Schedule for Later` is selected. `<input type="datetime-local">` with helper note: `Timezone: London (GMT/BST) • 15-min intervals`.
5. **Footer Action Buttons**
   * **Test SMS** (secondary white bordered button with mobile phone icon) -> opens **Send Test SMS Modal**.
   * **Send** / **Schedule** (primary `bg-blue-600` button with send icon) -> label should adapt to `Schedule` when `Schedule for Later` is selected; submits campaign after validation.

---

### 5.2 Right Column — Queued & History Panel (`lg:col-span-7`)

Fixed-height card (`h-[560px] lg:h-[720px] flex flex-col`) with an internally scrollable list area.

* **Tab Bar:**
  * `Queued (Future)` with orange count pill (`bg-orange-100 text-orange-700`) and active blue bottom border (`border-blue-600 text-blue-600`).
  * `History (Past)` with slate count pill (`bg-slate-200 text-slate-700`).

#### Queued Campaign Card
* **Header:** Campaign name, formatted scheduled timestamp (London GMT/BST), coverage pill (`Balance Covered` in emerald or deficit indicator in red), and status pill (`Scheduled` in orange).
* **Message Preview:** `bg-slate-50 border border-slate-100 rounded p-2.5 text-xs` displaying the full SMS text including the opt-out suffix (`Stop: dhsc.uk/x`).
* **3-Metric Strip (`grid-cols-1 sm:grid-cols-3`):**
  * `Valid Recipients`
  * `Segments (GSM-7 / UCS-2)`
  * `Total Cost`
* **Footer:** Relative dispatch countdown on the left (e.g., `Dispatches in 45 mins`) and a red `Cancel Campaign` button (with trash icon) on the right -> opens **Cancel Campaign Confirmation Modal**.

#### History Campaign Card
* **Header:** Campaign name, sent/completed timestamp, and status pill (`Sent` in green; also support `Cancelled` in slate and `Failed` in red).
* **Message Preview:** Read-only SMS copy block.
* **3-Metric Strip:** Final `Valid Recipients`, `Segments`, and `Total Cost`.
* *(No cancellation button.)*

---

## 6. Overlay Modals

All modals should render as centered overlay dialogs with dimmed backdrops, close (`✕`) controls, Escape-key dismissal, and focus trapping.

### 1. Send Test SMS Modal
* **Trigger:** `Test SMS` button in Create Campaign footer.
* **Body:** Draft summary (`1 segment, GSM-7`) + `Test Phone Number (UK +44)` `<input type="tel">` (`font-mono`, placeholder `+447700900077`).
* **Actions:** `Cancel` (secondary) and `Send Test` (`bg-slate-900 text-white`).

### 2. Opt-Out Blacklist Modal
* **Trigger:** `Opt-Outs (N)` button in the top header.
* **Body:**
  * Helper note: `Numbers listed here are automatically stripped from all campaign audiences.`
  * Inline add form: `<input type="tel" placeholder="+447700900077">` + `Add` button (`bg-blue-600 text-white`).
  * Scrollable list (`max-h-36` to `max-h-60`, `overflow-y-auto`, `font-mono`): phone number + orange `Opted Out` badge (optionally include a remove/unblock control if supported by backend).

### 3. Cancel Scheduled Campaign Confirmation Modal
* **Trigger:** `Cancel Campaign` button on a Queued Campaign card.
* **Body:**
  * Confirmation line naming the target campaign.
  * **Cancellation Safeguard Box:** Explains two steps: (1) deletes the scheduled batch on the SMS provider, and (2) marks the campaign cancelled and releases the reserved credits.
* **Actions:** `Keep Scheduled` (secondary) and `Confirm Cancel` (`bg-red-600 text-white`).

---

## 7. Interactive Controls Inventory

| Area | Control | Type | Expected Behavior |
| :--- | :--- | :--- | :--- |
| Header | `Opt-Outs (N)` | Button | Opens Opt-Out Blacklist modal. |
| Header | `Sync Balance` | Button | Fetches live balance from SMS API and refreshes KPI cards. |
| Deficit Banner | `Re-Sync Live Balance` | Button (conditional) | Re-fetches live balance when `reservedCredits > liveApiBalance`. |
| Create Form | `Campaign Name` | Text input | Campaign label (max 80 chars). |
| Create Form | `Message Body` | Textarea | SMS text; updates encoding, char count, segments, and cost live. |
| Create Form | `Delivery Schedule` | Radio group | Switches between immediate dispatch and scheduled dispatch. |
| Create Form | Schedule Date/Time | `datetime-local` | Shown only for `Schedule for Later`; enforces future UK time. |
| Create Form | `Test SMS` | Button | Opens Send Test SMS modal for the current message draft. |
| Create Form | `Send` / `Schedule` | Primary button | Validates form + available balance and submits campaign. |
| Campaigns Panel | `Queued` / `History` | Tabs | Switches between scheduled future campaigns and past campaigns. |
| Queued Card | `Cancel Campaign` | Destructive button | Opens Cancel Campaign confirmation modal for that campaign. |
| Test Modal | `Send Test` | Button | Validates UK `+44` number and sends a single test SMS. |
| Opt-Out Modal | `Add` | Form submit | Validates/normalizes number, adds to blacklist, refreshes valid recipient count. |
| Cancel Modal | `Confirm Cancel` | Destructive button | Cancels provider batch, marks campaign cancelled, releases reserved credits. |

---

## 8. Implementation Notes & Gaps Not Covered in Static HTML

When wiring this UI to real state and APIs, the AI assistant should implement these production essentials:

* **Dynamic State & Live Recalculation:** Bind balances, opt-out counts, valid recipients, segment counts, and queued countdowns to live state—never leave static prototype numbers hardcoded.
* **Encoding & Opt-Out Suffix Accounting:** Detect GSM-7 vs. UCS-2 characters on every keystroke and account for the appended `"Stop: dhsc.uk/x"` suffix length when computing remaining characters and segments.
* **Form & Balance Guards:** Disable `Send` / `Schedule` when the campaign name or message is empty, when the scheduled time is in the past, when message length exceeds policy limits, or when `totalEstCost > effectiveAvailable`.
* **UK Phone Validation:** Validate and normalize E.164 UK numbers (`+44...`) in both the Test SMS and Opt-Out Blacklist inputs, preventing duplicate opt-out entries.
* **Async & Feedback States:** Add loading spinners and disabled button states during API requests, plus toast/inline alerts for success and failure responses.
* **Empty States:** Render clear empty-state placeholders when `Queued`, `History`, or the `Opt-Out Blacklist` has zero records.
* **Accessibility:** Add `role="tablist"` / `role="tab"` / `aria-selected` for the Queued/History tabs, explicit `htmlFor`/`id` label associations on all form inputs, and `role="dialog"` + `aria-modal="true"` on all modals.