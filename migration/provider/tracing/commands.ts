import type Database from "better-sqlite3";
import { Command } from "commander";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CostReportRow {
  span_name: string;
  model: string | null;
  calls: number;
  total_tokens_in: number;
  total_tokens_out: number;
  cost_usd: number | null;
}

interface TraceReportRow {
  ts: string;
  span_name: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
}

// ─── Plain-text table renderer ────────────────────────────────────────────────

function renderTable(headers: string[], rows: string[][]): string {
  const allRows = [headers, ...rows];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");

  const lines = [fmt(allRows[0]!), sep, ...rows.map(fmt)];
  return lines.join("\n");
}

function fmt(n: number | null, decimals = 2): string {
  if (n === null) return "-";
  return n.toFixed(decimals);
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerTracingCommands(
  program: Command,
  db: () => Database.Database,
): void {

  // ── cost-report ─────────────────────────────────────────────────────────────

  program
    .command("cost-report")
    .description("Show LLM cost breakdown grouped by span and model")
    .option("--wave <n>", "Filter to a specific migration wave", parseInt)
    .option("--artifact <id>", "Filter to a specific artifact ID")
    .option("--phase <name>", "Filter by span_name (phase)")
    .option("--json", "Output raw JSON instead of a table")
    .action((opts: {
      wave?: number;
      artifact?: string;
      phase?: string;
      json?: boolean;
    }) => {
      const d = db();
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts.artifact) {
        conditions.push("t.artifact_id = ?");
        params.push(opts.artifact);
      }

      if (opts.wave !== undefined) {
        conditions.push(`EXISTS (
          SELECT 1 FROM runs r
          JOIN artifacts a ON a.id = t.artifact_id
          WHERE r.run_id = t.run_id AND a.wave = ?
        )`);
        params.push(opts.wave);
      }

      if (opts.phase) {
        conditions.push("t.span_name = ?");
        params.push(opts.phase);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `
        SELECT
          t.span_name,
          t.model,
          COUNT(*)                  AS calls,
          COALESCE(SUM(t.tokens_in), 0)  AS total_tokens_in,
          COALESCE(SUM(t.tokens_out), 0) AS total_tokens_out,
          SUM(t.cost_usd)           AS cost_usd
        FROM traces t
        ${where}
        GROUP BY t.span_name, t.model
        ORDER BY t.span_name, t.model
      `;

      const rows = d.prepare(sql).all(...params) as CostReportRow[];

      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }

      if (rows.length === 0) {
        process.stdout.write("No traces found.\n");
        return;
      }

      // Totals row
      const totals: CostReportRow = {
        span_name: "TOTAL",
        model: null,
        calls: rows.reduce((s, r) => s + r.calls, 0),
        total_tokens_in: rows.reduce((s, r) => s + r.total_tokens_in, 0),
        total_tokens_out: rows.reduce((s, r) => s + r.total_tokens_out, 0),
        cost_usd: rows.reduce(
          (s, r) => (r.cost_usd !== null ? (s ?? 0) + r.cost_usd : s),
          null as number | null,
        ),
      };

      const headers = ["span_name", "model", "calls", "tokens_in", "tokens_out", "cost_usd"];
      const tableRows = [...rows, totals].map((r) => [
        r.span_name,
        r.model ?? "-",
        String(r.calls),
        String(r.total_tokens_in),
        String(r.total_tokens_out),
        fmt(r.cost_usd, 6),
      ]);

      process.stdout.write(renderTable(headers, tableRows) + "\n");
    });

  // ── trace-report ─────────────────────────────────────────────────────────────

  program
    .command("trace-report")
    .description("Show recent LLM traces")
    .option("--run-id <id>", "Filter to a specific run ID")
    .option("--artifact <id>", "Filter to a specific artifact ID")
    .option("--limit <n>", "Max rows to show (default 50)", parseInt)
    .option("--json", "Output raw JSON instead of a table")
    .action((opts: {
      runId?: string;
      artifact?: string;
      limit?: number;
      json?: boolean;
    }) => {
      const d = db();
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts.runId) {
        conditions.push("run_id = ?");
        params.push(opts.runId);
      }

      if (opts.artifact) {
        conditions.push("artifact_id = ?");
        params.push(opts.artifact);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = opts.limit ?? 50;

      const sql = `
        SELECT ts, span_name, model, tokens_in, tokens_out, latency_ms, cost_usd
        FROM traces
        ${where}
        ORDER BY ts DESC
        LIMIT ?
      `;

      const rows = d.prepare(sql).all(...params, limit) as TraceReportRow[];

      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }

      if (rows.length === 0) {
        process.stdout.write("No traces found.\n");
        return;
      }

      const headers = ["ts", "span_name", "model", "tokens_in", "tokens_out", "latency_ms", "cost_usd"];
      const tableRows = rows.map((r) => [
        r.ts,
        r.span_name,
        r.model ?? "-",
        r.tokens_in  !== null ? String(r.tokens_in)  : "-",
        r.tokens_out !== null ? String(r.tokens_out) : "-",
        r.latency_ms !== null ? `${r.latency_ms}ms`  : "-",
        fmt(r.cost_usd, 6),
      ]);

      process.stdout.write(renderTable(headers, tableRows) + "\n");
    });
}
