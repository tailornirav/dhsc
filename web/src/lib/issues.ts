/**
 * Mapping helpers for the API's `validation_failed` payload.
 *
 * The Worker answers a bad campaign draft with `{ error: "validation_failed", issues: [...] }`
 * where each issue carries a `field`. The create form shows those inline, so we fold the list into
 * a `{ field: message }` map the panel consumes. Unknown fields are ignored (they still surface in
 * the toast) so a future server field never crashes the mapping.
 */

import type { FieldIssues } from "../components/CreateCampaignPanel";
import type { ValidationIssue } from "../types";

/** Fold a server issue list into the create form's per-field error map. */
export function FieldIssuesFromIssues(issues: ValidationIssue[]): FieldIssues {
  const mapped: FieldIssues = {};
  for (const issue of issues) {
    if (issue.field === "name" && mapped.name === undefined) mapped.name = issue.message;
    else if (issue.field === "message" && mapped.message === undefined) mapped.message = issue.message;
    else if (issue.field === "scheduleLocal" && mapped.scheduleLocal === undefined) {
      mapped.scheduleLocal = issue.message;
    } else if (issue.field === "recipients" && mapped.recipients === undefined) {
      mapped.recipients = issue.message;
    }
  }
  return mapped;
}
