import type Database from "better-sqlite3";
import type { TraceHook } from "../foundry-client";

// ─── Cost table ───────────────────────────────────────────────────────────────
// Prices in USD per 1 000 tokens: { in: input_cost, out: output_cost }

export const PER_TOKEN_COST_USD: Record<string, { in: number; out: number }> = {
  "gpt-5.4-nano":             { in: 0.00010,  out: 0.00040 },
  "gpt-4o":                   { in: 0.005,    out: 0.015   },
  "gpt-4o-mini":              { in: 0.00015,  out: 0.0006  },
  "gpt-35-turbo":             { in: 0.0005,   out: 0.0015  },
  "text-embedding-3-large":   { in: 0.00013,  out: 0       },
  "text-embedding-3-small":   { in: 0.00002,  out: 0       },
};

// ─── Hook options ─────────────────────────────────────────────────────────────

export interface DbTraceHookOptions {
  runId?: string;
  artifactId?: string;
  defaultSpanName?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns a TraceHook that writes one row to the `traces` table per call.
 * Pass the returned hook to `foundryClient.onTrace(hook)`.
 */
export function createDbTraceHook(
  db: Database.Database,
  opts: DbTraceHookOptions = {},
): TraceHook {
  const insert = db.prepare<{
    run_id: string | null;
    artifact_id: string | null;
    span_name: string;
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    latency_ms: number;
    cost_usd: number | null;
  }>(`
    INSERT INTO traces (run_id, artifact_id, span_name, model, tokens_in, tokens_out, latency_ms, cost_usd)
    VALUES (@run_id, @artifact_id, @span_name, @model, @tokens_in, @tokens_out, @latency_ms, @cost_usd)
  `);

  return (event) => {
    const spanName = event.spanName || opts.defaultSpanName || "unknown";
    const model = event.model ?? null;

    let costUsd: number | null = null;
    if (model !== null && event.tokensIn !== null) {
      const costs = PER_TOKEN_COST_USD[model];
      if (costs !== undefined) {
        const tokensOut = event.tokensOut ?? 0;
        costUsd = ((event.tokensIn * costs.in) + (tokensOut * costs.out)) / 1000;
      }
    }

    insert.run({
      run_id:      opts.runId      ?? null,
      artifact_id: opts.artifactId ?? null,
      span_name:   spanName,
      model,
      tokens_in:   event.tokensIn  ?? null,
      tokens_out:  event.tokensOut ?? null,
      latency_ms:  event.latencyMs,
      cost_usd:    costUsd,
    });
  };
}
