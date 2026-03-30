import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { idToSlug, RegistryError, validateId } from "../types";
import type { Agent, EventType } from "../types";

export interface AppendChangelogOptions {
  id: string;
  agent: Agent;
  type: EventType;
  entry: string;
}

export function appendChangelog(
  db: Database.Database,
  opts: AppendChangelogOptions,
): void {
  validateId(opts.id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(opts.id)) {
    throw new RegistryError(2, `Artifact not found: "${opts.id}"`);
  }

  const slug = idToSlug(opts.id);
  const dir = path.join("migration", "artifacts", slug);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, "changelog.md");
  const today = new Date().toISOString().slice(0, 10);
  const heading = `## ${today} — ${opts.type} (${opts.agent})`;
  const newEntry = `${heading}\n\n${opts.entry}\n\n`;
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  fs.writeFileSync(filePath, newEntry + existing, "utf-8");

  db.prepare(
    `
    INSERT INTO changelogs (artifact_id, file_path, last_entry, updated_at)
    VALUES (@artifact_id, @file_path, @last_entry, datetime('now'))
    ON CONFLICT (artifact_id) DO UPDATE SET
      file_path  = excluded.file_path,
      last_entry = excluded.last_entry,
      updated_at = excluded.updated_at
  `,
  ).run({ artifact_id: opts.id, file_path: filePath, last_entry: heading });
}

export function getChangelogPath(db: Database.Database, id: string): string {
  validateId(id);
  const row = db
    .prepare("SELECT file_path FROM changelogs WHERE artifact_id = ?")
    .get(id) as { file_path: string } | undefined;
  if (!row)
    throw new RegistryError(2, `No changelog found for artifact "${id}"`);
  return row.file_path;
}
