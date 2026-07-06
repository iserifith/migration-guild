import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { resolveGuildConfig, resolveWorkspaceRoot } from "../config";
import { findMatchingFiles, loadActiveStack } from "../stack";

export interface CoverageAuditResult {
  onDiskNotRegistered: string[];
  registeredMissingOnDisk: string[];
  registeredNonTerminal: string[];
}

const TERMINAL_STATUSES = new Set(["migrated", "reviewed", "completed", "skipped", "blocked"]);

export function runAuditCoverage(db: Database.Database, workspaceRoot = resolveWorkspaceRoot()): CoverageAuditResult {
  const projectRoot = workspaceRoot;
  const legacyDir = path.join(projectRoot, "legacy");

  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const pack = loadActiveStack(cfg, projectRoot);
  const filesOnDisk = findMatchingFiles(legacyDir, pack.manifest.source_globs);
  const pathsOnDisk = new Set(filesOnDisk.map((f) => path.relative(projectRoot, f)));

  const artifacts = db.prepare("SELECT path, status FROM artifacts").all() as Array<{ path: string; status: string }>;
  const pathsRegistered = new Set(artifacts.map((a) => a.path));
  const nonTerminal = artifacts
    .filter((a) => !TERMINAL_STATUSES.has(a.status))
    .map((a) => a.path);

  const onDiskNotRegistered = [...pathsOnDisk].filter((p) => !pathsRegistered.has(p)).sort();
  const registeredMissingOnDisk = artifacts
    .map((a) => a.path)
    .filter((p) => !fs.existsSync(path.join(projectRoot, p)))
    .sort();
  const registeredNonTerminal = [...nonTerminal].sort();

  return {
    onDiskNotRegistered,
    registeredMissingOnDisk,
    registeredNonTerminal,
  };
}

export function formatCoverageReport(result: CoverageAuditResult): string {
  const lines: string[] = [];

  if (result.onDiskNotRegistered.length > 0) {
    lines.push(`\n✗ On disk but not registered (${result.onDiskNotRegistered.length}):`);
    for (const p of result.onDiskNotRegistered) lines.push(`  - ${p}`);
  }

  if (result.registeredMissingOnDisk.length > 0) {
    lines.push(`\n✗ Registered but missing on disk (${result.registeredMissingOnDisk.length}):`);
    for (const p of result.registeredMissingOnDisk) lines.push(`  - ${p}`);
  }

  if (result.registeredNonTerminal.length > 0) {
    lines.push(`\n✗ Registered but non-terminal (${result.registeredNonTerminal.length}):`);
    for (const p of result.registeredNonTerminal) lines.push(`  - ${p}`);
  }

  if (lines.length === 0) {
    return "\n✓ Coverage audit passed: all files registered, all paths exist, all artifacts terminal.";
  }

  return lines.join("\n");
}
