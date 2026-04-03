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
  queryOpenBlockers,
  queryOpenIssues,
  queryRunHistory,
  queryEvaluationSummary,
  queryCostSummary,
} from "./queries";

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

export function startServer(db: Database.Database, port = 3322) {
  const server = http.createServer((req, res) => {
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

    if (p === "/api/wave-plan") {
      return json(res, queryWavePlanForUI(db));
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
      const threshold = Number(url.searchParams.get("stall_minutes") ?? 60);
      return json(res, queryStalledSessions(db, threshold));
    }

    if (p === "/api/blockers") {
      return json(res, queryOpenBlockers(db));
    }

    if (p === "/api/issues") {
      return json(res, queryOpenIssues(db));
    }

    if (p === "/api/runs") {
      return json(res, queryRunHistory(db, {
        agent:  url.searchParams.get("agent")  ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit:  Number(url.searchParams.get("limit") ?? 100),
      }));
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
        res.writeHead(404); res.end("UI not built. Run: npm run build:ui");
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
    const url = `http://localhost:${port}`;
    console.log(`\n  legmod registry inspector\n  ${url}\n`);
    // Try to open browser
    const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    require("child_process").exec(`${open} ${url}`);
  });

  process.on("SIGINT", () => { server.close(); process.exit(0); });
}
