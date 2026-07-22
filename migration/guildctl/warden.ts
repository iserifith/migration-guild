import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { appendEvent } from "../registry/commands/events";
import { deriveExpectedOutputPaths } from "../registry/commands/claim";
import type { Artifact } from "../registry/types";

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

function isPathWithin(file: string, root: string): boolean {
  const normalizedFile = normalizeAbsolute(file).replace(/\\/g, "/");
  const normalizedRoot = normalizeAbsolute(root).replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function isExcludedPath(file: string, excluded: Set<string>): boolean {
  for (const excludedPath of excluded) {
    if (isPathWithin(file, excludedPath)) return true;
  }
  return false;
}

function walk(root: string, excluded: Set<string>, dir = root): string[] {
  const out: string[] = [];
  if (isExcludedPath(dir, excluded)) return out;
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

function registeredExpectedOutputPaths(db: Database.Database | undefined, excludeArtifactId: string): string[] {
  if (!db) return [];
  try {
    const paths = new Set<string>();

    // Derive expected output paths from ALL registered artifacts, not just
    // those with active claims. This prevents the warden from reverting
    // legitimate shared dependency stubs (e.g. SystemGlobals.java, DAO
    // interfaces) that same-wave workers create as side effects before the
    // owning artifact has been claimed. The real migration overwrites the
    // stub; the stub surviving until then avoids wasted re-derivation.
    const artifactRows = db.prepare(`
      SELECT id, path FROM artifacts WHERE id != ?
    `).all(excludeArtifactId) as Array<{ id: string; path: string }>;
    for (const row of artifactRows) {
      const derived = deriveExpectedOutputPaths({ path: row.path } as Artifact);
      for (const p of derived) paths.add(p);
    }

    // Also include paths explicitly recorded in claims (covers edge cases
    // where claim expected_output_paths differ from derived).
    const claimRows = db.prepare(`
      SELECT expected_output_paths
      FROM artifact_claims
      WHERE expected_output_paths IS NOT NULL
        AND artifact_id != ?
    `).all(excludeArtifactId) as Array<{ expected_output_paths: string }>;
    for (const row of claimRows) {
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
  // Parallel workers share one workspace. Every path sanctioned by a sibling
  // artifact's claim is legitimate migration output; otherwise one worker can
  // restore/delete a sibling worker's completed file after taking its earlier
  // snapshot. The current artifact's own outputs are governed solely by
  // opts.allowedPaths so that review-phase enforcement (which passes an empty
  // allowlist) still fails closed on post-verification mutations of them.
  const allowedPaths = [...opts.allowedPaths, ...registeredExpectedOutputPaths(db, opts.artifactId)];

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

export function transientWardenExclusions(workspaceRoot: string, extraPaths: string[] = []): string[] {
  return [
    path.join(workspaceRoot, ".guild", "evidence"),
    path.join(workspaceRoot, "modern", ".gradle"),
    path.join(workspaceRoot, "modern", "build"),
    ...extraPaths,
  ].map(normalizeAbsolute);
}
