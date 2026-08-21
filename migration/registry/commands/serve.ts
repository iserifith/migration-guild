import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import {
  querySocietyArtifactReport,
  querySocietyReport,
} from "../../guildctl/commands/society-report";
import {
  queryArtifactsForUI,
  queryStatusSummary,
  queryWavePlanForUI,
  queryEventsForUI,
  queryStalledSessions,
  queryStalledSessionsPage,
  queryOpenBlockers,
  queryOpenBlockersPage,
  queryOpenIssues,
  queryOpenIssuesPage,
  queryRunHistory,
  queryRunHistoryPage,
  queryPendingApprovalsForUI,
  queryApprovalHistoryForUI,
} from "./queries";
import { recordApprovalDecision } from "./approval";
import { RegistryError } from "../types";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".map":  "application/json",
};

// ui-dist is one level up from registry/dist/ → migration/ui-dist/
const UI_DIR = path.join(__dirname, "..", "..", "ui-dist");

function serveStatic(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function json(res: http.ServerResponse, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// Clean 4xx error body matching the API's existing plain-text error
// convention (see the /api/runs/<id>/log 404s below).
function jsonError(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(message);
}

// Minimal JSON-body reader for POST handlers (none existed before US4).
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // Guard against unbounded bodies.
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

// Default operator id for dashboard-initiated approval decisions when the
// request body does not supply one (US4). Mirrors the CLI's stable
// "guildctl-approve" operator id.
const DASHBOARD_OPERATOR_ID = "mission-control";

function numberParam(
  value: string | null,
  fallback: number | undefined,
): number | undefined {
  if (value == null) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function startServer(db: Database.Database, port = 3322) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const p = url.pathname;

    // ── API routes ────────────────────────────────────────────────────────
    //
    // All data access goes through query helpers in commands/queries.ts.
    // This file is intentionally a thin HTTP dispatcher — no raw SQL here.

    if (p === "/api/artifacts") {
      return json(res, queryArtifactsForUI(db, {
        status: url.searchParams.get("status") ?? undefined,
        module: url.searchParams.get("module") ?? undefined,
        kind:   url.searchParams.get("kind")   ?? undefined,
        tier:   url.searchParams.get("tier")   ?? undefined,
      }));
    }

    if (p === "/api/status") {
      return json(res, queryStatusSummary(db));
    }

    if (req.method === "GET" && p === "/api/society") {
      const report = querySocietyReport(db);
      const id = url.searchParams.get("id");
      return json(res, id
        ? { ...report, artifact: querySocietyArtifactReport(db, id) }
        : report);
    }

    if (p === "/api/wave-plan") {
      return json(res, queryWavePlanForUI(db));
    }

    // ── /api/approvals (US4, spec 013) ────────────────────────────────────
    // Thin dispatcher: the read delegates to queryPendingApprovalsForUI,
    // which returns exactly the set listPendingApprovals (CLI) returns.
    if (req.method === "GET" && p === "/api/approvals") {
      return json(res, queryPendingApprovalsForUI(db));
    }

    // Decided history for the approvals panel (newest first).
    if (req.method === "GET" && p === "/api/approvals/history") {
      return json(res, queryApprovalHistoryForUI(db));
    }

    // ── POST /api/approvals/<id>/decision (US4, spec 013) ─────────────────
    // Thin dispatcher around the shared registry function recordApprovalDecision
    // (the same one the CLI calls). RegistryError is translated into the API's
    // clean 4xx plain-text error body; success → 200 + the ApprovalDecision JSON.
    const approvalDecisionMatch = p.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (req.method === "POST" && approvalDecisionMatch) {
      const artifactId = decodeURIComponent(approvalDecisionMatch[1]);
      let body: Record<string, unknown>;
      try {
        const parsed = await readJsonBody(req);
        body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      } catch (err) {
        return jsonError(res, 400, err instanceof Error ? err.message : "Request body is not valid JSON.");
      }

      const decision = typeof body.decision === "string" ? body.decision : "";
      if (decision !== "approved" && decision !== "rejected") {
        return jsonError(res, 400, 'decision must be "approved" or "rejected".');
      }

      try {
        const recorded = recordApprovalDecision(db, {
          artifactId,
          decision,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          operator:
            typeof body.operator === "string" && body.operator.trim()
              ? body.operator
              : DASHBOARD_OPERATOR_ID,
          runId: typeof body.runId === "string" ? body.runId : undefined,
          operatorToken: typeof body.operatorToken === "string" ? body.operatorToken : undefined,
        });
        return json(res, recorded);
      } catch (err) {
        if (err instanceof RegistryError) {
          return jsonError(res, 400, err.message);
        }
        throw err;
      }
    }

    if (p === "/api/events") {
      const id    = url.searchParams.get("id");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!id) return json(res, []);
      return json(res, queryEventsForUI(db, id, limit));
    }

    // ── Future slice endpoints ────────────────────────────────────────────
    // These are intentionally wired up now so later feature-slice agents
    // have a stable URL contract to code against.  The query helpers already
    // return full data; slices only need to add filtering / UI.

    if (p === "/api/sessions") {
      const threshold = numberParam(url.searchParams.get("stall_minutes"), 60) ?? 60;
      const shouldPage =
        url.searchParams.has("page") ||
        url.searchParams.has("page_size") ||
        url.searchParams.has("status") ||
        url.searchParams.has("stalled") ||
        url.searchParams.has("sort");

      if (!shouldPage) {
        return json(res, queryStalledSessions(db, threshold));
      }

      return json(res, queryStalledSessionsPage(db, {
        thresholdMinutes: threshold,
        status: url.searchParams.get("status") ?? undefined,
        stalled: (url.searchParams.get("stalled") as "all" | "stalled" | "active" | null) ?? undefined,
        sort: (url.searchParams.get("sort") as "age-desc" | "age-asc" | "artifact" | null) ?? undefined,
        page: numberParam(url.searchParams.get("page"), 1),
        pageSize: numberParam(url.searchParams.get("page_size"), 25),
      }));
    }

    if (p === "/api/blockers") {
      const shouldPage = url.searchParams.toString() !== "";
      if (!shouldPage) {
        return json(res, queryOpenBlockers(db));
      }

      return json(res, queryOpenBlockersPage(db, {
        q: url.searchParams.get("q") ?? undefined,
        sort: (url.searchParams.get("sort") as "oldest" | "newest" | "artifact" | null) ?? undefined,
        page: numberParam(url.searchParams.get("page"), 1),
        pageSize: numberParam(url.searchParams.get("page_size"), 25),
      }));
    }

    if (p === "/api/issues") {
      const shouldPage = url.searchParams.toString() !== "";
      if (!shouldPage) {
        return json(res, queryOpenIssues(db));
      }

      return json(res, queryOpenIssuesPage(db, {
        severity: url.searchParams.get("severity") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        sort: (url.searchParams.get("sort") as "severity" | "latest" | "artifact" | null) ?? undefined,
        page: numberParam(url.searchParams.get("page"), 1),
        pageSize: numberParam(url.searchParams.get("page_size"), 25),
      }));
    }

    // ── /api/runs/<runId>/log — plain-text log file for one run ──────────
    //
    // The UI's fetchRunLog() calls this endpoint; the route matches
    // /api/runs/<id>/log and streams the run's log_file as text/plain.
    // Returns 404 when the run or the log file is missing.
    const runLogMatch = p.match(/^\/api\/runs\/([^/]+)\/log$/);
    if (req.method === "GET" && runLogMatch) {
      const runId = decodeURIComponent(runLogMatch[1]);
      const run = db.prepare("SELECT log_file FROM runs WHERE run_id = ?").get(runId) as
        | { log_file: string | null }
        | undefined;

      if (!run) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Run not found");
        return;
      }

      const logPath = run.log_file;
      if (!logPath || !fs.existsSync(logPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Log file not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(logPath).pipe(res);
      return;
    }

    if (p === "/api/runs") {
      const shouldPage =
        url.searchParams.has("page") ||
        url.searchParams.has("page_size") ||
        url.searchParams.has("model") ||
        url.searchParams.has("sort");

      if (shouldPage) {
        return json(res, queryRunHistoryPage(db, {
          agent: url.searchParams.get("agent") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          model: url.searchParams.get("model") ?? undefined,
          sort: (url.searchParams.get("sort") as "newest" | "oldest" | "agent" | "duration" | null) ?? undefined,
          page: numberParam(url.searchParams.get("page"), 1),
          pageSize: numberParam(url.searchParams.get("page_size"), 25),
        }));
      }

      return json(res, queryRunHistory(db, {
        agent:  url.searchParams.get("agent")  ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit:  numberParam(url.searchParams.get("limit"), 100) ?? 100,
      }));
    }


    // ── Static UI ─────────────────────────────────────────────────────────
    if (p === "/" || p === "/index.html") {
      const index = path.join(UI_DIR, "index.html");
      if (!serveStatic(res, index)) {
        res.writeHead(404); res.end("UI not built. Run from the workspace root: npm --prefix migration/ui run build");
      }
      return;
    }

    const file = path.join(UI_DIR, p);
    if (!serveStatic(res, file)) {
      // SPA fallback
      const index = path.join(UI_DIR, "index.html");
      if (!serveStatic(res, index)) { res.writeHead(404); res.end("Not found"); }
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    const url = `http://localhost:${actualPort}`;
    console.log(`\n  Migration Guild registry inspector\n  ${url}\n`);
    if (port === 0) return;
    // Try to open browser
    const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    require("child_process").exec(`${open} ${url}`);
  });

  process.on("SIGINT", () => { server.close(); process.exit(0); });
  return server;
}
