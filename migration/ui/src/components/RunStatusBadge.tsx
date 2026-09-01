/**
 * RunStatusBadge — the shared four-state run-status vocabulary badge
 * (spec 016, #220): `working` | `idle` | `waiting-for-approval` | `rejected`.
 *
 * One canonical presentation reused wherever an artifact's run status is
 * shown (the artifact list today; any future per-artifact status surface),
 * so "waiting-for-approval"/"rejected" (sourced from the existing spec-013
 * US4 ApprovalsPanel data path) read as part of the same visual system as
 * the two new derived states "working"/"idle" — not a separate ad hoc style.
 *
 * Purely presentational: takes a single RunStatusEntry (or just its label)
 * and renders the matching colour/text from constants.ts. Data fetching
 * lives in hooks.ts (useRunStatus).
 */
import { memo } from "react";
import { RUN_STATUS_COLORS, RUN_STATUS_LABELS } from "../constants";
import type { RunStatusLabel } from "../types";

export interface RunStatusBadgeProps {
  label: RunStatusLabel;
  /** Optional title/tooltip override; defaults to a human-readable summary. */
  title?: string;
}

const RunStatusBadge = memo(function RunStatusBadge({ label, title }: RunStatusBadgeProps) {
  return (
    <span
      className={`run-status-badge run-status-${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: RUN_STATUS_COLORS[label],
        border: `1px solid ${RUN_STATUS_COLORS[label]}`,
        background: "transparent",
      }}
      title={title ?? RUN_STATUS_LABELS[label]}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: RUN_STATUS_COLORS[label],
        }}
      />
      {RUN_STATUS_LABELS[label]}
    </span>
  );
});

export default RunStatusBadge;

/**
 * Legend of all four labels, used near existing status displays (App.tsx)
 * so operators can see the full vocabulary at a glance (US3).
 */
export const RunStatusLegend = memo(function RunStatusLegend() {
  const labels: RunStatusLabel[] = ["working", "idle", "waiting-for-approval", "rejected"];
  return (
    <div
      aria-label="Run status legend"
      style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
    >
      {labels.map((label) => (
        <RunStatusBadge key={label} label={label} />
      ))}
    </div>
  );
});
