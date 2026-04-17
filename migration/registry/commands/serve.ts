import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
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
  queryRunLogFile,
  queryEvaluationSummary,
  queryCostSummary,
} from "./queries";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

// ui-dist is one level up from registry/dist/ → migration/ui-dist/
const UI_DIR = path.join(__dirname, "..", "..", "ui-dist");

function serveStatic(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function json(res: http.ServerResponse, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

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
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const p = url.pathname;

    // ── API routes ────────────────────────────────────────────────────────
    //
    // All data access goes through query helpers in commands/queries.ts.
    // This file is intentionally a thin HTTP dispatcher — no raw SQL here.

    if (p === "/api/artifacts") {
      return json(
        res,
        queryArtifactsForUI(db, {
          status: url.searchParams.get("status") ?? undefined,
          module: url.searchParams.get("module") ?? undefined,
          kind: url.searchParams.get("kind") ?? undefined,
          tier: url.searchParams.get("tier") ?? undefined,
        }),
      );
    }

    if (p === "/api/status") {
      return json(res, queryStatusSummary(db));
    }

    if (p === "/api/wave-plan") {
      return json(res, queryWavePlanForUI(db));
    }

    if (p === "/api/events") {
      const id = url.searchParams.get("id");
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

      return json(
        res,
        queryStalledSessionsPage(db, {
          thresholdMinutes: threshold,
          status: url.searchParams.get("status") ?? undefined,
          stalled:
            (url.searchParams.get("stalled") as "all" | "stalled" | "active" | null) ??
            undefined,
          sort:
            (url.searchParams.get("sort") as
              | "age-desc"
              | "age-asc"
              | "artifact"
              | null) ?? undefined,
          page: numberParam(url.searchParams.get("page"), 1),
          pageSize: numberParam(url.searchParams.get("page_size"), 25),
        }),
      );
    }

    if (p === "/api/blockers") {
      const shouldPage = url.searchParams.toString() !== "";
      if (!shouldPage) {
        return json(res, queryOpenBlockers(db));
      }

      return json(
        res,
        queryOpenBlockersPage(db, {
          q: url.searchParams.get("q") ?? undefined,
          sort:
            (url.searchParams.get("sort") as "oldest" | "newest" | "artifact" | null) ??
            undefined,
          page: numberParam(url.searchParams.get("page"), 1),
          pageSize: numberParam(url.searchParams.get("page_size"), 25),
        }),
      );
    }

    if (p === "/api/issues") {
      const shouldPage = url.searchParams.toString() !== "";
      if (!shouldPage) {
        return json(res, queryOpenIssues(db));
      }

      return json(
        res,
        queryOpenIssuesPage(db, {
          severity: url.searchParams.get("severity") ?? undefined,
          category: url.searchParams.get("category") ?? undefined,
          sort:
            (url.searchParams.get("sort") as "severity" | "latest" | "artifact" | null) ??
            undefined,
          page: numberParam(url.searchParams.get("page"), 1),
          pageSize: numberParam(url.searchParams.get("page_size"), 25),
        }),
      );
    }

    if (p === "/api/runs") {
      const shouldPage =
        url.searchParams.has("page") ||
        url.searchParams.has("page_size") ||
        url.searchParams.has("model") ||
        url.searchParams.has("sort");

      if (shouldPage) {
        return json(
          res,
          queryRunHistoryPage(db, {
            agent: url.searchParams.get("agent") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            model: url.searchParams.get("model") ?? undefined,
            sort:
              (url.searchParams.get("sort") as
                | "newest"
                | "oldest"
                | "agent"
                | "duration"
                | null) ?? undefined,
            page: numberParam(url.searchParams.get("page"), 1),
            pageSize: numberParam(url.searchParams.get("page_size"), 25),
          }),
        );
      }

      return json(
        res,
        queryRunHistory(db, {
          agent: url.searchParams.get("agent") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          limit: numberParam(url.searchParams.get("limit"), 100) ?? 100,
        }),
      );
    }

    const runLogMatch = /^\/api\/runs\/([^/]+)\/log$/.exec(p);
    if (runLogMatch) {
      const runId = decodeURIComponent(runLogMatch[1]!);
      const logFile = queryRunLogFile(db, runId);
      if (!logFile) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Run not found or no log recorded");
        return;
      }
      if (!fs.existsSync(logFile)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Log file not found on disk: ${logFile}`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Log-File": logFile,
      });
      fs.createReadStream(logFile).pipe(res);
      return;
    }

    if (p === "/api/evaluations") {
      const artifactId = url.searchParams.get("id") ?? undefined;
      return json(res, queryEvaluationSummary(db, artifactId));
    }

    if (p === "/api/cost") {
      return json(res, queryCostSummary(db));
    }

    // ── Static UI ─────────────────────────────────────────────────────────
    if (p === "/" || p === "/index.html") {
      const index = path.join(UI_DIR, "index.html");
      if (!serveStatic(res, index)) {
        res.writeHead(404);
        res.end("UI not built. Run: npm run build:ui");
      }
      return;
    }

    const file = path.join(UI_DIR, p);
    if (!serveStatic(res, file)) {
      // SPA fallback
      const index = path.join(UI_DIR, "index.html");
      if (!serveStatic(res, index)) {
        res.writeHead(404);
        res.end("Not found");
      }
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  legmod registry inspector\n  ${url}\n`);
    // Try to open browser
    const open =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    require("child_process").exec(`${open} ${url}`);
  });

  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}
