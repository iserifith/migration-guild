import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { MappingStrategy, StackMapping } from "../types";

export interface CreateMappingOptions {
  legacy_framework: string;
  target_framework: string;
  strategy?: MappingStrategy;
  notes?: string;
}

export function createMapping(
  db: Database.Database,
  opts: CreateMappingOptions,
): StackMapping {
  if (!opts.legacy_framework || !opts.target_framework) {
    throw new RegistryError(1, "Both --legacy and --target are required.");
  }

  const existing = db
    .prepare("SELECT id FROM stack_mappings WHERE legacy_framework = ? AND target_framework = ?")
    .get(opts.legacy_framework, opts.target_framework);
  if (existing) {
    throw new RegistryError(
      3,
      `Mapping already exists: "${opts.legacy_framework}" → "${opts.target_framework}"`,
    );
  }

  db.prepare(`
    INSERT INTO stack_mappings (legacy_framework, target_framework, strategy, notes)
    VALUES (@legacy_framework, @target_framework, @strategy, @notes)
  `).run({
    legacy_framework: opts.legacy_framework,
    target_framework: opts.target_framework,
    strategy: opts.strategy ?? null,
    notes: opts.notes ?? null,
  });

  return db
    .prepare("SELECT * FROM stack_mappings WHERE legacy_framework = ? AND target_framework = ?")
    .get(opts.legacy_framework, opts.target_framework) as StackMapping;
}

export function confirmMapping(
  db: Database.Database,
  id: string,
  confirmedBy: string,
  notes?: string,
): StackMapping {
  const mapping = db
    .prepare("SELECT * FROM stack_mappings WHERE id = ?")
    .get(id) as StackMapping | undefined;
  if (!mapping) throw new RegistryError(2, `Mapping not found: "${id}"`);

  db.prepare(`
    UPDATE stack_mappings
    SET confirmed = 1,
        confirmed_by = ?,
        confirmed_at = datetime('now'),
        notes = COALESCE(?, notes)
    WHERE id = ?
  `).run(confirmedBy, notes ?? null, id);

  return db.prepare("SELECT * FROM stack_mappings WHERE id = ?").get(id) as StackMapping;
}

export function listMappings(
  db: Database.Database,
  confirmedOnly = false,
): StackMapping[] {
  const sql = confirmedOnly
    ? "SELECT * FROM stack_mappings WHERE confirmed = 1 ORDER BY legacy_framework"
    : "SELECT * FROM stack_mappings ORDER BY confirmed ASC, legacy_framework";
  return db.prepare(sql).all() as StackMapping[];
}

export function getMappingsSummary(db: Database.Database): {
  total: number;
  confirmed: number;
  unconfirmed: number;
  mappings: StackMapping[];
} {
  const mappings = db
    .prepare("SELECT * FROM stack_mappings ORDER BY confirmed ASC, legacy_framework")
    .all() as StackMapping[];
  const confirmed = mappings.filter((m) => m.confirmed === 1).length;
  return {
    total: mappings.length,
    confirmed,
    unconfirmed: mappings.length - confirmed,
    mappings,
  };
}

/** Returns true if stack_mappings exist but any are unconfirmed. Used by planner guard. */
export function hasUnconfirmedMappings(db: Database.Database): boolean {
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM stack_mappings").get() as { n: number }
  ).n;
  if (total === 0) return false;
  const unconfirmed = (
    db.prepare("SELECT COUNT(*) AS n FROM stack_mappings WHERE confirmed = 0").get() as { n: number }
  ).n;
  return unconfirmed > 0;
}
