import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * guildctl ccmap — export the migration registry as a CodeCharta 2.0 map
 * (https://github.com/MaibornWolff/codecharta).
 *
 * The registry is projected as a code city:
 *   guild / wave-XX / <kind> / <artifact-slug>  (File leaf, link = artifact path)
 * and each leaf carries metrics in lenses.metrics.attributes keyed by node id:
 *   status_code     numeric index into STATUS_ORDER (color by this)
 *   wave            migration wave number (0 = unplanned)
 *   event_count     total events recorded against the artifact
 *   evidence_count  acceptance-evidence rows
 *   verify_slot_count verification leases taken
 *   claim_age_days  days since last claim, 0 when unclaimed
 *
 * attributeDescriptors carry the human titles for studio tooltips.
 *
 * Output is apiVersion 2.0 {meta, files, lenses} — the same format the
 * CodeCharta Web Studio ships its own samples in, so no ccsh conversion is
 * needed. `ccsh check` passes on the result.
 */
import type { Status } from "../../registry/types";

const STATUS_ORDER: Status[] = [
  "pending",
  "planned",
  "analyzed",
  "in-progress",
  "tests-written",
  "migrated",
  "reviewed",
  "needs-rework",
  "pending-approval",
  "completed",
  "blocked",
  "skipped",
];

interface CcNode {
  id: string;
  name: string;
  type: "Folder" | "File";
  children?: CcNode[];
  link?: string;
}

interface CcMap {
  meta: { projectName: string; apiVersion: string; checksum: string };
  files: CcNode[];
  lenses: {
    metrics: {
      attributes: Record<string, Record<string, number>>;
      attributeDescriptors: Record<string, Record<string, unknown>>;
      attributeTypes: Record<string, unknown>;
    };
    dependency: { edges: unknown[]; attributeTypes: Record<string, unknown>; attributeDescriptors: Record<string, unknown> };
  };
}

function shortId(): string {
  return createHash("md5").update(randomUUID()).digest("hex").slice(0, 16);
}

function descriptor(title: string, description: string, direction = -1): Record<string, unknown> {
  return { title, description, hintLowValue: "", hintHighValue: "", link: "", direction, analyzers: [] };
}

export function buildCcMap(db: Database.Database, projectName: string): CcMap {
  const artifacts = db
    .prepare(
      `SELECT id, slug, kind, tier, path, status, wave
       FROM artifacts
       ORDER BY wave, kind, slug`,
    )
    .all() as Array<{ id: string; slug: string; kind: string; tier: string; path: string; status: string; wave: number | null }>;

  const eventCounts = new Map<string, number>(
    (
      db.prepare(`SELECT artifact_id, COUNT(*) AS n FROM events GROUP BY artifact_id`).all() as Array<{
        artifact_id: string;
        n: number;
      }>
    ).map((r) => [r.artifact_id, r.n]),
  );
  const evidenceCounts = new Map<string, number>(
    (
      db
        .prepare(`SELECT artifact_id, COUNT(*) AS n FROM acceptance_evidence GROUP BY artifact_id`)
        .all() as Array<{ artifact_id: string; n: number }>
    ).map((r) => [r.artifact_id, r.n]),
  );
  const verifySlotCounts = new Map<string, number>(
    (
      db.prepare(`SELECT artifact_id, COUNT(*) AS n FROM verify_slots GROUP BY artifact_id`).all() as Array<{
        artifact_id: string;
        n: number;
      }>
    ).map((r) => [r.artifact_id, r.n]),
  );
  const claimAges = new Map<string, number>(
    (
      db
        .prepare(
          `SELECT id, CASE WHEN claimed_at IS NULL THEN 0
                            ELSE CAST((julianday('now') - claimed_at) AS INTEGER) END AS age
           FROM artifacts`,
        )
        .all() as Array<{ id: string; age: number }>
    ).map((r) => [r.id, Math.max(0, r.age)]),
  );

  const root: CcNode = { id: shortId(), name: "guild", type: "Folder", children: [] };
  const attributes: Record<string, Record<string, number>> = {};

  for (const a of artifacts) {
    const wave = a.wave ?? 0;
    const waveName = `wave-${String(wave).padStart(2, "0")}`;
    const waveFolder = ensureChild(root, waveName);
    const kindFolder = ensureChild(waveFolder, a.kind);
    const leaf: CcNode = {
      id: shortId(),
      name: a.slug,
      type: "File",
      link: a.path,
    };
    kindFolder.children!.push(leaf);
    const statusIdx = STATUS_ORDER.indexOf(a.status as Status);
    attributes[leaf.id] = {
      status_code: statusIdx >= 0 ? statusIdx : 0,
      wave,
      event_count: eventCounts.get(a.id) ?? 0,
      evidence_count: evidenceCounts.get(a.id) ?? 0,
      verify_slot_count: verifySlotCounts.get(a.id) ?? 0,
      claim_age_days: claimAges.get(a.id) ?? 0,
    };
  }

  const ccMap: CcMap = {
    meta: {
      projectName,
      apiVersion: "2.0",
      checksum: createHash("md5").update(JSON.stringify(artifacts.map((a) => a.id))).digest("hex"),
    },
    files: [root],
    lenses: {
      metrics: {
        attributes,
        attributeDescriptors: {
          status_code: descriptor("Status", "Numeric index of the migration status (see guildctl status for names)."),
          wave: descriptor("Wave", "Migration wave number."),
          event_count: descriptor("Event churn", "Total events recorded against this artifact."),
          evidence_count: descriptor("Evidence records", "Acceptance-evidence rows for this artifact."),
          verify_slot_count: descriptor("Verify slots", "Verification leases taken on this artifact."),
          claim_age_days: descriptor("Claim age (days)", "Days since the last verification claim; 0 = never claimed."),
        },
        attributeTypes: {},
      },
      dependency: { edges: [], attributeTypes: {}, attributeDescriptors: {} },
    },
  };
  return ccMap;
}

function ensureChild(folder: CcNode, name: string): CcNode {
  let child = folder.children!.find((c) => c.name === name);
  if (!child) {
    child = { id: shortId(), name, type: "Folder", children: [] };
    folder.children!.push(child);
  }
  return child;
}

export interface CcMapOptions {
  output?: string;
  stdout?: boolean;
  gzip?: boolean;
}

export function runCcMap(db: Database.Database, projectName: string, opts: CcMapOptions = {}): string {
  const map = buildCcMap(db, projectName);
  const json = JSON.stringify(map);
  if (opts.stdout) {
    process.stdout.write(json);
    return json;
  }
  const out = opts.output ?? path.join(process.cwd(), "codecharta-map.cc.json");
  fs.writeFileSync(out, json, "utf8");
  console.log(`wrote ${out}`);
  console.log(
    `artifacts: ${Object.keys(map.lenses.metrics.attributes).length} · view with the CodeCharta Web Studio`,
  );
  return json;
}
