import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { appendEvent } from "../registry/commands/events";

export interface WardenFileSnapshot {
  path: string;
  bytes: Buffer;
  sha256: string;
}

export interface WardenSnapshot {
  files: Map<string, WardenFileSnapshot>;
}

export interface WardenViolation {
  path: string;
  kind: "created" | "modified" | "deleted";
}

export interface EnforceWardenOptions {
  artifactId: string;
  workspaceRoot: string;
  snapshot: WardenSnapshot;
  allowedPaths: string[];
  excludedPaths?: string[];
  agent: string;
}

export interface WardenResult {
  clean: boolean;
  violations: WardenViolation[];
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function normalizeAbsolute(file: string): string {
  return path.resolve(file);
}

function sqliteSidecarPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

export function activeSqliteWardenExclusions(db: Database.Database | undefined): string[] {
  if (!db || db.name === ":memory:") return [];
  const rows = db.prepare("PRAGMA database_list").all() as Array<{ file?: string | null }>;
  const files = rows.map((row) => row.file).filter((file): file is string => !!file && file !== ":memory:");
  return [...new Set(files.flatMap(sqliteSidecarPaths).map(normalizeAbsolute))];
}

function excludedPathSet(paths: string[] | undefined): Set<string> {
  return new Set((paths ?? []).map(normalizeAbsolute));
}

function isExcludedPath(file: string, excluded: Set<string>): boolean {
  const normalized = normalizeAbsolute(file);
  for (const excludedPath of excluded) {
    const relative = path.relative(excludedPath, normalized);
    if (relative === "") return true;
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return true;
    }
  }
  return false;
}

function walk(root: string, excluded: Set<string>, dir = root): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (isExcludedPath(full, excluded)) continue;
    // Registry context/changelog files are authoritative runtime state written
    // by registry CLI commands on behalf of workers. They are not worker source
    // edits and must survive warden enforcement, including when the workspace
    // reaches the package through a junction or nested source checkout.
    if (entry.isDirectory() && entry.name === "artifacts" && path.basename(dir) === "migration") continue;
    if (entry.isDirectory()) out.push(...walk(root, excluded, full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function isAllowed(file: string, allowedPaths: string[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return allowedPaths.some((allowed) => {
    const a = allowed.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized === a || normalized.startsWith(`${a}/`);
  });
}

function registeredExpectedOutputPaths(db: Database.Database | undefined): string[] {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT expected_output_paths
      FROM artifact_claims
      WHERE expected_output_paths IS NOT NULL
    `).all() as Array<{ expected_output_paths: string }>;
    const paths = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.expected_output_paths) as unknown;
        if (Array.isArray(parsed)) {
          for (const value of parsed) if (typeof value === "string" && value) paths.add(value);
        }
      } catch {
        // Ignore malformed historical claim metadata; the current claim's
        // validated allowed paths are still enforced by the caller.
      }
    }
    return [...paths];
  } catch {
    return [];
  }
}

export function snapshotWorkspaceForWarden(workspaceRoot: string): WardenSnapshot {
  return snapshotWorkspaceForWardenWithExclusions(workspaceRoot, []);
}

export function snapshotWorkspaceForWardenWithExclusions(workspaceRoot: string, excludedPaths: string[] = []): WardenSnapshot {
  const excluded = excludedPathSet(excludedPaths);
  const files = new Map<string, WardenFileSnapshot>();
  for (const full of walk(workspaceRoot, excluded)) {
    const bytes = fs.readFileSync(full);
    const relative = rel(workspaceRoot, full);
    files.set(relative, { path: relative, bytes, sha256: sha256(bytes) });
  }
  return { files };
}

function restoreFile(root: string, file: string, snapshot: WardenFileSnapshot): void {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, snapshot.bytes);
}

export function enforceWardenSnapshot(
  db: Database.Database | undefined,
  opts: EnforceWardenOptions,
): WardenResult {
  const after = snapshotWorkspaceForWardenWithExclusions(opts.workspaceRoot, opts.excludedPaths);
  const all = new Set([...opts.snapshot.files.keys(), ...after.files.keys()]);
  const violations: WardenViolation[] = [];
  const excluded = excludedPathSet(opts.excludedPaths);
  // Parallel workers share one workspace. Every path sanctioned by any claim
  // is legitimate migration output; otherwise one worker can restore/delete a
  // sibling worker's completed file after taking its earlier snapshot.
  const allowedPaths = [...opts.allowedPaths, ...registeredExpectedOutputPaths(db)];

  for (const file of [...all].sort()) {
    if (isExcludedPath(path.join(opts.workspaceRoot, file), excluded)) continue;
    if (isAllowed(file, allowedPaths)) continue;
    const before = opts.snapshot.files.get(file);
    const current = after.files.get(file);
    if (!before && current) {
      violations.push({ path: file, kind: "created" });
      fs.rmSync(path.join(opts.workspaceRoot, file), { force: true });
    } else if (before && !current) {
      violations.push({ path: file, kind: "deleted" });
      restoreFile(opts.workspaceRoot, file, before);
    } else if (before && current && before.sha256 !== current.sha256) {
      violations.push({ path: file, kind: "modified" });
      restoreFile(opts.workspaceRoot, file, before);
    }
  }

  if (violations.length > 0 && db) {
    appendEvent(db, {
      id: opts.artifactId,
      type: "filesystem-violation",
      agent: opts.agent,
      summary: `${violations.length} unauthorized filesystem change(s) restored`,
      data: JSON.stringify({ violations }),
    });
  }

  return { clean: violations.length === 0, violations };
}
