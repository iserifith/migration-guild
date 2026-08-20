import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { resolveVerificationBudgetMs, resolveVerifyMaxConcurrent, type GuildConfig } from "../../guildctl/config";

/**
 * US5 (#151) / T022: bounded verify concurrency via a lease table.
 *
 * `verify_slots` mirrors the existing `artifact_claims` lease shape. At most
 * `verification.max_concurrent` rows may be live (`released_at IS NULL` and
 * `lease_expires_at > now()`) at any moment. Acquisition is a single atomic
 * `INSERT … SELECT … WHERE (live count) < limit` statement, so two sessions
 * racing on the same registry cannot both observe "under the limit" and both
 * insert — the same insert-if-under-limit pattern `claimArtifactById` uses to
 * enforce one-active-claim-per-artifact.
 *
 * The lease is bounded: `lease_expires_at` is `acquired_at` + a ceiling derived
 * from the verify budget, so a crashed holder never permanently consumes a
 * slot. A live-looking row whose lease has lapsed is stale and is reclaimed by
 * the next acquire attempt, mirroring lease-expiry reconciliation for claims.
 */

export interface VerifySlot {
  slot_id: string;
  run_id: string | null;
  artifact_id: string;
  acquired_at: string;
  lease_expires_at: string;
  released_at: string | null;
}

export interface AcquireVerifySlotOptions {
  runId?: string | null;
  artifactId: string;
  config?: Pick<GuildConfig, "verification">;
  env?: Record<string, string | undefined>;
  /** Poll interval while waiting for a slot to free up (ms). */
  pollMs?: number;
  /** Maximum time to wait for a slot before giving up (ms). 0 = no wait cap. */
  maxWaitMs?: number;
  /** Injected clock for tests; returns a `Date`-compatible ms value. */
  now?: () => number;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function makeSlotId(): string {
  return randomUUID().replace(/-/g, "");
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function liveCount(db: Database.Database, nowIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM verify_slots
       WHERE released_at IS NULL AND lease_expires_at > ?`,
    )
    .get(nowIso) as { n: number };
  return row.n;
}

function reclaimStale(db: Database.Database, nowIso: string): void {
  // A holder that never released and whose lease lapsed is stale; mark it
  // released so it stops counting against the live cap. This is the same
  // reconciliation the claims lease-expiry path performs.
  db.prepare(
    `UPDATE verify_slots SET released_at = ?
     WHERE released_at IS NULL AND lease_expires_at <= ?`,
  ).run(nowIso, nowIso);
}

/**
 * Try to insert one live slot row, atomically, only if the live count is
 * currently under `maxConcurrent`. Returns the new slot on success, null when
 * the pool is full. The `INSERT … SELECT … WHERE` form makes the
 * count-check-and-insert a single statement, so a concurrent acquirer cannot
 * slip between the read and the write.
 */
function tryAcquire(
  db: Database.Database,
  opts: { runId: string | null; artifactId: string; maxConcurrent: number; nowMs: number; leaseCeilingMs: number },
): VerifySlot | null {
  const nowIso = toIso(opts.nowMs);
  const leaseIso = toIso(opts.nowMs + opts.leaseCeilingMs);
  const slotId = makeSlotId();
  const result = db
    .prepare(
      `INSERT INTO verify_slots (slot_id, run_id, artifact_id, acquired_at, lease_expires_at, released_at)
       SELECT @slot_id, @run_id, @artifact_id, @acquired_at, @lease_expires_at, NULL
       WHERE (SELECT COUNT(*) FROM verify_slots
              WHERE released_at IS NULL AND lease_expires_at > @now) < @max_concurrent`,
    )
    .run({
      slot_id: slotId,
      run_id: opts.runId,
      artifact_id: opts.artifactId,
      acquired_at: nowIso,
      lease_expires_at: leaseIso,
      now: nowIso,
      max_concurrent: opts.maxConcurrent,
    });
  if (result.changes === 0) return null;
  return getSlot(db, slotId);
}

export function getSlot(db: Database.Database, slotId: string): VerifySlot {
  return db.prepare("SELECT * FROM verify_slots WHERE slot_id = ?").get(slotId) as VerifySlot;
}

/**
 * Acquire a verify slot, waiting (with a bounded poll) until one frees up.
 * Reclaims stale leases before each attempt. Resolves with the held slot; the
 * caller MUST call `releaseVerifySlot` in a `finally`.
 */
export async function acquireVerifySlot(
  db: Database.Database,
  opts: AcquireVerifySlotOptions,
): Promise<VerifySlot> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const config = opts.config;
  const env = opts.env ?? process.env;
  const maxConcurrent = resolveVerifyMaxConcurrent(config, env);
  // The lease ceiling is a small multiple of the verify budget so a legitimate
  // long-running check is never reclaimed mid-flight, but a crashed holder's
  // slot still frees up promptly.
  const leaseCeilingMs = Math.max(resolveVerificationBudgetMs(config, env) * 2, 30_000);
  const pollMs = Math.max(10, opts.pollMs ?? 50);
  const maxWaitMs = opts.maxWaitMs ?? 0;

  const startMs = now();
  for (;;) {
    const nowMs = now();
    reclaimStale(db, toIso(nowMs));
    const slot = tryAcquire(db, {
      runId: opts.runId ?? null,
      artifactId: opts.artifactId,
      maxConcurrent,
      nowMs,
      leaseCeilingMs,
    });
    if (slot) return slot;
    if (maxWaitMs > 0 && nowMs - startMs >= maxWaitMs) {
      throw new Error(
        `verify slot not acquired within ${maxWaitMs}ms (max_concurrent=${maxConcurrent}); ` +
          `${liveCount(db, toIso(nowMs))} slot(s) still live`,
      );
    }
    await sleep(pollMs);
  }
}

/** Release a held slot; idempotent. */
export function releaseVerifySlot(db: Database.Database, slotId: string): void {
  db.prepare(
    `UPDATE verify_slots SET released_at = datetime('now')
     WHERE slot_id = ? AND released_at IS NULL`,
  ).run(slotId);
}

/** Current number of live (held, unexpired) slots — observability/test hook. */
export function countLiveVerifySlots(db: Database.Database): number {
  return liveCount(db, toIso(Date.now()));
}

/**
 * Run `fn` while holding one verify slot, releasing it in a `finally` so the
 * slot is freed exactly once whether `fn` resolves or rejects (T023).
 */
export async function withVerifySlot<T>(
  db: Database.Database,
  opts: AcquireVerifySlotOptions,
  fn: (slot: VerifySlot) => Promise<T> | T,
): Promise<T> {
  const slot = await acquireVerifySlot(db, opts);
  try {
    return await fn(slot);
  } finally {
    releaseVerifySlot(db, slot.slot_id);
  }
}
