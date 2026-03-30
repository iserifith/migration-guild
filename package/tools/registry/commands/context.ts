import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { idToSlug, RegistryError, validateId } from "../types";
import type { Agent } from "../types";

function extractSummary(content: string): string {
  const match = content.match(
    /^##\s+Summary\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\s*$)/m,
  );
  if (!match) {
    throw new RegistryError(
      1,
      'Context file must contain a "## Summary" section',
    );
  }
  return match[1].trim();
}

export function writeContext(
  db: Database.Database,
  id: string,
  agent: Agent,
  filePath: string,
): void {
  validateId(id);

  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }
  if (!fs.existsSync(filePath)) {
    throw new RegistryError(2, `Context file not found: "${filePath}"`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const summary = extractSummary(content);
  const slug = idToSlug(id);
  const destDir = path.join("migration", "artifacts", slug, "context");
  fs.mkdirSync(destDir, { recursive: true });

  const destFile = path.join(destDir, `${agent}.md`);
  fs.copyFileSync(filePath, destFile);

  db.prepare(
    `
    INSERT INTO agent_context (artifact_id, agent, file_path, summary, updated_at)
    VALUES (@artifact_id, @agent, @file_path, @summary, datetime('now'))
    ON CONFLICT (artifact_id, agent) DO UPDATE SET
      file_path  = excluded.file_path,
      summary    = excluded.summary,
      updated_at = excluded.updated_at
  `,
  ).run({ artifact_id: id, agent, file_path: destFile, summary });
}

export function getContextPath(
  db: Database.Database,
  id: string,
  agent: Agent,
): string {
  validateId(id);
  const row = db
    .prepare(
      "SELECT file_path FROM agent_context WHERE artifact_id = ? AND agent = ?",
    )
    .get(id, agent) as { file_path: string } | undefined;
  if (!row) {
    throw new RegistryError(
      2,
      `No context found for artifact "${id}", agent "${agent}"`,
    );
  }
  return row.file_path;
}
