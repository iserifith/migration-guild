/**
 * Shared role-classification helpers for UI components.
 */

import type { SocietyRole } from "../types";

/**
 * Maps a (possibly-null) agent identifier onto one of the three society roles.
 *
 * The nullable signature accommodates both the MissionControl callers (which pass
 * a non-null agent string) and the SocietyView callers (which pass `claimed_by`
 * and similar columns that may be null). A null/blank agent resolves to `builder`.
 */
export function classifyRole(agent: string | null): SocietyRole {
  if (/critic|review|test/i.test(agent ?? "")) return "critic";
  if (/arbiter/i.test(agent ?? "")) return "arbiter";
  return "builder";
}
