import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";

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
    const pathname = url.pathname;

    // ── API routes ────────────────────────────────────────────────────────
    if (pathname === "/api/artifacts") {
      const status = url.searchParams.get("status");
      const module = url.searchParams.get("module");
      const kind   = url.searchParams.get("kind");
      let q = "SELECT * FROM artifacts WHERE 1=1";
      const params: string[] = [];
      if (status) { q += " AND status = ?"; params.push(status); }
      if (module) { q += " AND module = ?"; params.push(module); }
      if (kind)   { q += " AND kind = ?";   params.push(kind);   }
      q += " ORDER BY wave ASC NULLS LAST, id ASC";
      return json(res, db.prepare(q).all(...params));
    }

    if (pathname === "/api/status") {
      const rows = db.prepare(
        "SELECT status, COUNT(*) as n FROM artifacts GROUP BY status"
      ).all() as { status: string; n: number }[];
      const by_status: Record<string, number> = {};
      let total = 0, in_progress = 0, completed = 0;
      for (const r of rows) {
        by_status[r.status] = r.n;
        total += r.n;
        if (r.status === "in-progress") in_progress = r.n;
        if (["migrated","reviewed","completed","skipped"].includes(r.status)) completed += r.n;
      }
      const op = db.prepare("SELECT key, value FROM operator_state WHERE key IN ('current_focus','next_action')").all() as
        { key: string; value: string }[];
      const opMap = Object.fromEntries(op.map((r) => [r.key, r.value]));
      return json(res, {
        files: { total, completed, in_progress, by_status },
        current_focus: opMap["current_focus"] ?? null,
        next: opMap["next_action"] ?? null,
      });
    }

    if (pathname === "/api/wave-plan") {
      const rows = db.prepare(
        "SELECT wave, status, COUNT(*) as n FROM artifacts WHERE wave IS NOT NULL GROUP BY wave, status ORDER BY wave"
      ).all() as { wave: number; status: string; n: number }[];
      const plan = new Map<number, Record<string, number>>();
      for (const r of rows) {
        if (!plan.has(r.wave)) plan.set(r.wave, {});
        plan.get(r.wave)![r.status] = r.n;
      }
      return json(res, [...plan.entries()].map(([wave, by_status]) => ({
        wave, total: Object.values(by_status).reduce((a, b) => a + b, 0), by_status,
      })));
    }

    if (pathname === "/api/events") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, []);
      return json(res, db.prepare(
        "SELECT event_id as id, type as event_type, agent, summary as note, ts as created_at FROM events WHERE artifact_id = ? ORDER BY ts DESC LIMIT 50"
      ).all(id));
    }

    // ── Static UI ─────────────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      const index = path.join(UI_DIR, "index.html");
      if (!serveStatic(res, index)) {
        res.writeHead(404); res.end("UI not built. Run: npm run build:ui");
      }
      return;
    }

    const file = path.join(UI_DIR, pathname);
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
