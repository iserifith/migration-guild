import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import type Database from "better-sqlite3";
import type { LoadedStackPack } from "./stack";
import { findMatchingFiles } from "./stack";
import { listArtifacts } from "../registry/commands/queries";
import { upsertProposedDisposition } from "../registry/commands/dispositions";
import type { DependencyDispositionKind } from "../registry/types";

/**
 * Stack-pack `dependencies:` block loader + deterministic disposition collector
 * (specs/006-dependency-disposition). T011 is the loader; T012 is the
 * collector — same file, sequential.
 *
 * The loader reuses the exact YAML parsing path of loadClassificationSpec
 * (classification.ts): `parse(fs.readFileSync(pack.dir/classification_spec))`.
 * A pack WITHOUT the optional block is valid — the collector degrades to a
 * findings-derived library universe with keep-default proposals (fail-closed
 * toward keep, never toward silent pruning — spec edge case #2).
 */

export interface DispositionPackSpec {
  manifest_globs: string[];
  library_prefixes: Record<string, string[]>;
  native_equivalents: Record<string, { native: string; note?: string }>;
}

export interface LoadedDispositionSpec {
  spec: DispositionPackSpec;
  warnings: string[];
}

const ALLOWED_DEPENDENCIES_KEYS = new Set(["manifest_globs", "library_prefixes", "native_equivalents"]);

interface RawDependenciesBlock {
  manifest_globs?: unknown;
  library_prefixes?: unknown;
  native_equivalents?: unknown;
}

export function loadDispositionSpec(pack: LoadedStackPack): LoadedDispositionSpec {
  const manifest = pack.manifest as typeof pack.manifest & { classification_spec?: string };
  if (!manifest.classification_spec) {
    throw new Error(`[guildctl] Stack pack ${pack.manifest.id} is missing classification_spec`);
  }
  const specPath = path.join(pack.dir, manifest.classification_spec);
  const raw = parse(fs.readFileSync(specPath, "utf8")) as { dependencies?: unknown };
  const block = (raw.dependencies ?? {}) as RawDependenciesBlock;
  const warnings: string[] = [];

  for (const key of Object.keys(block)) {
    if (!ALLOWED_DEPENDENCIES_KEYS.has(key)) {
      throw new Error(`[guildctl] Stack pack ${pack.manifest.id} classification.yaml: unknown key "dependencies.${key}"`);
    }
  }

  const manifestGlobs = parseManifestGlobs(block.manifest_globs, pack.manifest.id);
  const libraryPrefixes = parseLibraryPrefixes(block.library_prefixes, pack.manifest.id);
  const nativeEquivalents = parseNativeEquivalents(block.native_equivalents, pack.manifest.id);

  for (const library of Object.keys(nativeEquivalents)) {
    if (!(library in libraryPrefixes)) {
      warnings.push(
        `[guildctl] Stack pack ${pack.manifest.id}: native_equivalents entry "${library}" is absent from library_prefixes — the proposal seed is still used, but usage analysis has no prefix mapping for it`,
      );
    }
  }

  return { spec: { manifest_globs: manifestGlobs, library_prefixes: libraryPrefixes, native_equivalents: nativeEquivalents }, warnings };
}

function parseManifestGlobs(value: unknown, packId: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`[guildctl] Stack pack ${packId}: dependencies.manifest_globs must be an array of non-empty strings`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`[guildctl] Stack pack ${packId}: dependencies.manifest_globs entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

function parseLibraryPrefixes(value: unknown, packId: string): Record<string, string[]> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[guildctl] Stack pack ${packId}: dependencies.library_prefixes must be a map of library → non-empty string array`);
  }
  const result: Record<string, string[]> = {};
  for (const [library, prefixes] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((p) => typeof p !== "string" || p.trim() === "")) {
      throw new Error(`[guildctl] Stack pack ${packId}: dependencies.library_prefixes["${library}"] must be a non-empty string array`);
    }
    result[library] = prefixes.map((p) => (p as string).trim());
  }
  return result;
}

function parseNativeEquivalents(value: unknown, packId: string): Record<string, { native: string; note?: string }> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[guildctl] Stack pack ${packId}: dependencies.native_equivalents must be a map of library → { native, note? }`);
  }
  const result: Record<string, { native: string; note?: string }> = {};
  for (const [library, entry] of Object.entries(value as Record<string, unknown>)) {
    const obj = (entry ?? {}) as { native?: unknown; note?: unknown };
    if (typeof obj.native !== "string" || obj.native.trim() === "") {
      throw new Error(`[guildctl] Stack pack ${packId}: dependencies.native_equivalents["${library}"].native must be a non-empty string`);
    }
    result[library] = {
      native: obj.native.trim(),
      note: typeof obj.note === "string" && obj.note.trim() !== "" ? obj.note.trim() : undefined,
    };
  }
  return result;
}

// ─── Collector (T012) ────────────────────────────────────────────────────────

export interface DispositionCollectorSummary {
  libraries: string[];
  /** FR-012: scan limitations that degraded the universe/usage analysis. */
  scan_notes: string[];
  warnings: string[];
}

interface LibraryEvidence {
  libraryName: string;
  versions: string[];
  usageArtifacts: Set<string>;
  importCount: number;
  declaredButUnused: boolean;
  scanNotes: string[];
  nativeEquivalent?: { native: string; note?: string };
}

const MAX_USING_ARTIFACTS = 20;

/**
 * Library universe = dependency_findings (grouped by dependency_name, MAX
 * current_version) UNION regex-level manifest extraction (research.md §3).
 * Every library gets exactly one proposed disposition row, seeded from the
 * pack's native_equivalents and defaulting to `keep` when unmapped — the
 * non-keep decision always belongs to the operator at confirmation, never to
 * the collector (spec edge cases #1/#2).
 */
export function collectDispositions(
  db: Database.Database,
  pack: LoadedStackPack,
  workspaceRoot: string,
): DispositionCollectorSummary {
  const { spec, warnings } = loadDispositionSpec(pack);
  const scanNotes: string[] = [];

  // 1. Library universe: findings (MAX current_version per library) ∪
  //    manifest-extracted declarations.
  const findings = db.prepare(`
    SELECT dependency_name, MAX(current_version) AS current_version
    FROM dependency_findings
    WHERE dependency_name IS NOT NULL AND dependency_name != ''
    GROUP BY dependency_name
  `).all() as Array<{ dependency_name: string; current_version: string | null }>;

  const manifestVersions = new Map<string, string[]>();
  const manifestGlobs = spec.manifest_globs.length > 0 ? spec.manifest_globs : pack.manifest.manifest_globs;
  const manifestFiles = findMatchingFiles(path.join(workspaceRoot, "legacy"), manifestGlobs);
  const parsersByBasename = new Map(pack.manifest.dependency_parsers.map((parser) => [parser.match, parser]));
  for (const filePath of manifestFiles) {
    const parser = parsersByBasename.get(path.basename(filePath));
    if (!parser) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const regex = new RegExp(parser.pattern, parser.flags);
    const matches = [...content.matchAll(regex)];
    if (matches.length === 0) {
      scanNotes.push(`manifest ${path.relative(workspaceRoot, filePath)}: no declarations could be extracted (unparseable or empty)`);
      continue;
    }
    for (const match of matches) {
      const group = match[1]?.trim();
      const artifact = match[2]?.trim();
      const version = match[3]?.trim();
      if (!group || !artifact) continue;
      const coordinate = `${group}:${artifact}`;
      const list = manifestVersions.get(coordinate) ?? [];
      if (version) list.push(version);
      manifestVersions.set(coordinate, list);
    }
  }
  if (manifestGlobs.length > 0 && manifestFiles.length === 0) {
    scanNotes.push("no manifest files matched the configured manifest_globs — manifest-derived declarations unavailable");
  }

  const universe = new Map<string, LibraryEvidence>();
  for (const finding of findings) {
    universe.set(finding.dependency_name, {
      libraryName: finding.dependency_name,
      versions: finding.current_version ? [finding.current_version] : [],
      usageArtifacts: new Set(),
      importCount: 0,
      declaredButUnused: false,
      scanNotes: [],
    });
  }
  for (const [coordinate, versions] of manifestVersions) {
    const existing = universe.get(coordinate);
    if (existing) {
      existing.versions.push(...versions);
    } else {
      universe.set(coordinate, {
        libraryName: coordinate,
        versions: [...versions],
        usageArtifacts: new Set(),
        importCount: 0,
        declaredButUnused: false,
        scanNotes: [],
      });
    }
  }

  // 2. Usage analysis: import/qualified-reference matches against the pack's
  //    library_prefixes over registered legacy-source artifacts (mirrors the
  //    collectLineMatches-style heuristics in guildctl/audit.ts).
  const artifacts = listArtifacts(db, { kind: "legacy-source" });
  const importRe = /^\s*import\s+(?:static\s+)?([\w.]+);?\s*$/;
  for (const artifact of artifacts) {
    const absPath = path.join(workspaceRoot, artifact.path);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, "utf8");
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(importRe);
      if (match) imports.add(match[1]!);
      else if (/^\s*import\s+/.test(line)) {
        // Multi-line / unusual import forms: try a greedy package grab.
        const greedy = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)/);
        if (greedy) imports.add(greedy[1]!);
      }
    }

    for (const evidence of universe.values()) {
      const prefixes = spec.library_prefixes[evidence.libraryName];
      if (!prefixes || prefixes.length === 0) {
        if (evidence.importCount === 0 && !evidence.declaredButUnused) {
          evidence.scanNotes.push(`no usage-prefix mapping for ${evidence.libraryName} — usage analysis limited to qualified-reference matches`);
        }
        // Prefix-free libraries can still be detected via qualified references
        // (e.g. `org.joda.time.DateTime` without an import on the same line).
        const qualified = new RegExp(`\\b${escapeRegExp(evidence.libraryName.split(":")[1] ?? "")}\\b`).test(content);
        if (qualified) {
          evidence.usageArtifacts.add(artifact.id);
          evidence.importCount += 1;
        }
        continue;
      }
      const used = prefixes.some((prefix) => imports.has(prefix) || [...imports].some((imp) => imp === prefix || imp.startsWith(`${prefix}.`)));
      if (used) {
        evidence.usageArtifacts.add(artifact.id);
        evidence.importCount += 1;
      }
    }
  }

  // 3. Proposal seeding: native_equivalents → replace-with-native; everything
  //    else defaults to keep (fail-closed). Declared-but-unused libraries get
  //    keep + a scan-limitation note — never an invented removal.
  const resolved = [...universe.values()].sort((a, b) => a.libraryName.localeCompare(b.libraryName));
  for (const evidence of resolved) {
    const usingArtifacts = [...evidence.usageArtifacts].slice(0, MAX_USING_ARTIFACTS).sort();
    const versions = [...new Set(evidence.versions)].sort(compareVersions);
    const maxVersion = versions[versions.length - 1] ?? null;
    const native = spec.native_equivalents[evidence.libraryName];
    // FR-008: conflicting observed versions resolve to MAX; the conflict
    // narrative rides in the proposal rationale.
    const conflictNarrative = versions.length > 1
      ? ` Version conflict across findings/manifests (${versions.join(", ")}); resolved to MAX ${maxVersion} per research.md §9.`
      : "";

    let disposition: DependencyDispositionKind;
    let rationale: string;
    let nativeReplacement: string | undefined;
    let lockedTargetVersion: string | undefined;
    const usageNotes: string[] = [];

    if (evidence.declaredButUnused || usingArtifacts.length === 0) {
      evidence.declaredButUnused = true;
      disposition = "keep";
      lockedTargetVersion = maxVersion ?? undefined;
      usageNotes.push("no registered legacy artifact imports this library (scan-limitation: usage evidence may be incomplete)");
      rationale = (native
        ? `Keep proposal seeded by collector: declared in manifests but no usage evidence found (scan-limitation). Advisory native equivalent ${native.native} exists but applies only when usage is confirmed.`
        : "Keep proposal seeded by collector: declared in manifests but no usage evidence found (scan-limitation). Confirm with override if this library should be replaced or inlined.") + conflictNarrative;
    } else if (native) {
      disposition = "replace-with-native";
      nativeReplacement = native.native;
      rationale = `Replace-with-native proposal seeded by collector from pack native_equivalents: ${native.native}.${native.note ? ` ${native.note}` : ""}${conflictNarrative}`;
    } else {
      disposition = "keep";
      lockedTargetVersion = maxVersion ?? undefined;
      rationale = "Keep proposal seeded by collector: used by legacy artifacts and no native equivalent is declared in the stack pack." + conflictNarrative;
    }

    const usageJson = JSON.stringify({
      using_artifacts: usingArtifacts,
      using_artifact_count: usingArtifacts.length,
      import_count: evidence.importCount,
      scan_notes: [...usageNotes, ...evidence.scanNotes],
    });

    upsertProposedDisposition(db, {
      libraryName: evidence.libraryName,
      currentVersion: maxVersion,
      disposition,
      nativeReplacement,
      lockedTargetVersion,
      rationale,
      usageJson,
      proposedBy: "planner-collector",
    });
  }

  return {
    libraries: resolved.map((evidence) => evidence.libraryName),
    scan_notes: scanNotes,
    warnings,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Version-aware ordering (research.md §9): numeric dotted segments compare
 * numerically ("2.10.0" > "2.9.0"); anything non-numeric falls back to plain
 * lexicographic comparison of the whole string.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const numeric = pa.every((s) => /^\d+$/.test(s)) && pb.every((s) => /^\d+$/.test(s));
  if (!numeric) return a.localeCompare(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i] ?? "0");
    const nb = Number(pb[i] ?? "0");
    if (na !== nb) return na - nb;
  }
  return 0;
}
