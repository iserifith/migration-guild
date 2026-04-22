/**
 * Shared UI constants for the legmod registry inspector.
 *
 * Keep filter option lists, status colour mappings, and the tab registry here
 * so individual components never hard-code values that need to stay in sync
 * with the backend vocabulary.
 */

import type { ArtifactStatus } from "./types";

// ── Status semantics ──────────────────────────────────────────────────────────

/** Statuses considered "done" when calculating wave progress percentages. */
export const DONE_STATUSES: ArtifactStatus[] = [
  "migrated",
  "reviewed",
  "completed",
  "skipped",
];

// ── Filter option lists (value "" = "show all") ───────────────────────────────

export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "",              label: "All statuses"  },
  { value: "pending",       label: "pending"       },
  { value: "planned",       label: "planned"       },
  { value: "analyzed",      label: "analyzed"      },
  { value: "in-progress",   label: "in-progress"   },
  { value: "tests-written", label: "tests-written" },
  { value: "migrated",      label: "migrated"      },
  { value: "reviewed",      label: "reviewed"      },
  { value: "needs-rework",  label: "needs-rework"  },
  { value: "blocked",       label: "blocked"       },
  { value: "skipped",       label: "skipped"       },
];

export const KIND_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "",                label: "All kinds"        },
  { value: "legacy-source",    label: "legacy-source"    },
  { value: "target-source",    label: "target-source"    },
  { value: "test",             label: "test"             },
  { value: "module",           label: "module"           },
  { value: "config",           label: "config"           },
  { value: "descriptor",       label: "descriptor"       },
  { value: "sql-schema",       label: "sql-schema"       },
  { value: "properties",       label: "properties"       },
  { value: "shared-constants", label: "shared-constants" },
];

// ── Colour palette for status badges and wave charts ─────────────────────────

export const STATUS_COLORS: Readonly<Record<string, string>> = {
  pending:         "#94a3b8",
  planned:         "#60a5fa",
  analyzed:        "#818cf8",
  "in-progress":   "#f59e0b",
  "tests-written": "#34d399",
  migrated:        "#4ade80",
  reviewed:        "#c084fc",
  "needs-rework":  "#f87171",
  blocked:         "#ef4444",
  completed:       "#4ade80",
  skipped:         "#6b7280",
};

/** Fallback colour when a status has no explicit entry in STATUS_COLORS. */
export const STATUS_COLOR_FALLBACK = "#888";

// ── Tab registry ──────────────────────────────────────────────────────────────
//
// CURRENTLY IMPLEMENTED tabs appear in the TABS array in App.tsx.
// PLANNED tabs are listed below as documentation for future slice authors.
//
// When adding a new monitoring slice:
//   1. Add a TabDef entry to the TABS array in App.tsx (render function included).
//   2. Add the API function to api.ts if needed.
//   3. Add/adjust types in types.ts.
//   4. Remove the tab name from PLANNED_MONITORING_TABS below.
//
// Planned (not yet implemented):
//   "Claimability" — artifacts ready-to-claim per wave (no unresolved deps)
//   "Batch Jobs"   — foundry batch job queue
//   "Dependencies" — artifact dependency graph
