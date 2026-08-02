/**
 * Shared hermetic fixtures for the truthful-run-state suites.
 *
 * Deliberately NOT named `*.test.ts`: the runtime suite glob is
 * `test/*.test.ts` (see migration/package.json), and this file exports helpers
 * rather than tests.
 *
 * Portability conventions follow `run-reliability.test.ts`:
 *  - the repo's `migration/` root is derived from cwd (`npm --prefix migration
 *    test` runs with cwd = the migration package root), with a `__dirname`
 *    fallback so a direct `node --test` invocation still resolves;
 *  - anything handed to `node --import` is a `file://` URL, because absolute
 *    Windows paths are rejected there.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── Paths ───────────────────────────────────────────────────────────────────

/** The repository's `migration/` directory, derived without hardcoding. */
export function repoMigrationRoot(): string {
  const fromCwd = process.cwd();
  if (path.basename(fromCwd) === "migration") return fromCwd;
  return path.resolve(__dirname, "..");
}

/** `file://` URL of the tsx loader, safe to pass to `node --import`. */
export function tsxLoaderUrl(root = repoMigrationRoot()): string {
  return pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "loader.mjs")).href;
}

/** Create a throwaway directory for one test's workspace. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ─── Injectable provider `fetch` stub ────────────────────────────────────────

export interface StubProviderResponse {
  /** HTTP status to report. Defaults to 200. */
  status?: number;
  /** Parsed JSON body. Ignored when `bodyText` is given. */
  body?: unknown;
  /** Raw body text — use to simulate a malformed (non-JSON) response. */
  bodyText?: string;
  /** When set, the call rejects with this error instead of responding. */
  networkError?: string;
  /** Artificial latency in ms, for budget-elapse cases. */
  delayMs?: number;
}

export interface StubFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubFetch {
  /** Drop-in replacement for global `fetch`. */
  fetch: (input: unknown, init?: unknown) => Promise<Response>;
  /** Every call made, in order — assert that no credential value leaked. */
  calls: StubFetchCall[];
}

/**
 * Build an injectable `fetch` that replays the given responses in order,
 * repeating the last one once exhausted. No socket is ever opened.
 */
export function createStubFetch(responses: StubProviderResponse[]): StubFetch {
  const calls: StubFetchCall[] = [];
  let index = 0;

  const fetchImpl = async (input: unknown, init?: unknown): Promise<Response> => {
    const initObj = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    let parsedBody: unknown = initObj.body;
    if (typeof initObj.body === "string") {
      try {
        parsedBody = JSON.parse(initObj.body);
      } catch {
        parsedBody = initObj.body;
      }
    }
    calls.push({
      url: String(input),
      method: initObj.method ?? "GET",
      headers: { ...(initObj.headers ?? {}) },
      body: parsedBody,
    });

    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;

    if (spec.delayMs && spec.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    }
    if (spec.networkError) {
      throw new Error(spec.networkError);
    }

    const status = spec.status ?? 200;
    const text = spec.bodyText ?? JSON.stringify(spec.body ?? {});
    return new Response(text, {
      status,
      headers: { "content-type": spec.bodyText ? "text/plain" : "application/json" },
    });
  };

  return { fetch: fetchImpl, calls };
}

/** A `2xx` body carrying a non-empty completion — the only shape that passes. */
export function completionBody(content = "ok"): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

/** A `2xx` body whose completion is empty — explicitly not a pass. */
export function emptyCompletionBody(): unknown {
  return { choices: [{ message: { role: "assistant", content: "" } }] };
}

// ─── Fake harness adapter ────────────────────────────────────────────────────

export interface FakeHarnessOptions {
  /** Text the adapter prints to stdout. Empty string simulates "starts but says nothing". */
  reply?: string;
  /** Exit code. Defaults to 0. */
  exitCode?: number;
  /** Milliseconds to sleep before replying, for budget tests. */
  delayMs?: number;
  /** File the adapter appends its argv to, so a test can assert on the invocation. */
  argvLogPath?: string;
}

/**
 * Write a Node-based fake harness adapter and return its path. It answers
 * `--version` like a real adapter so availability probes succeed, and otherwise
 * emits the configured reply.
 */
export function writeFakeHarnessAdapter(dir: string, opts: FakeHarnessOptions = {}): string {
  const file = path.join(dir, "fake-harness.mjs");
  const reply = opts.reply ?? "fake harness reply";
  const exitCode = opts.exitCode ?? 0;
  const delayMs = opts.delayMs ?? 0;
  writeFileSync(file, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
const argvLog = ${JSON.stringify(opts.argvLogPath ?? null)};
if (argvLog) appendFileSync(argvLog, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) {
  process.stdout.write("fake-harness 0.0.0\\n");
  process.exit(0);
}
const delayMs = ${delayMs};
const finish = () => {
  const reply = ${JSON.stringify(reply)};
  if (reply) process.stdout.write(reply + "\\n");
  process.exit(${exitCode});
};
if (delayMs > 0) setTimeout(finish, delayMs); else finish();
`, { mode: 0o755 });
  return file;
}

// ─── SIGTERM-ignoring grandchild spawner ─────────────────────────────────────

export interface GrandchildSpawnerOptions {
  /** When true the whole tree ignores SIGTERM, forcing escalation to SIGKILL. */
  ignoreSigterm?: boolean;
  /** File each process touches once alive, so a test can wait for readiness. */
  readyFile?: string;
  /** File each process appends its pid to, so survivors can be identified. */
  pidFile?: string;
  /** How long the tree stays alive if never terminated (ms). */
  lifetimeMs?: number;
}

/**
 * Write a Node script that spawns a detached grandchild and then idles. Used to
 * prove that terminating an attempt reaches the whole process group and not
 * only the direct child.
 */
export function writeGrandchildSpawner(dir: string, opts: GrandchildSpawnerOptions = {}): string {
  const file = path.join(dir, "grandchild-spawner.mjs");
  const lifetimeMs = opts.lifetimeMs ?? 60_000;
  writeFileSync(file, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const ignoreSigterm = ${opts.ignoreSigterm ? "true" : "false"};
const readyFile = ${JSON.stringify(opts.readyFile ?? null)};
const pidFile = ${JSON.stringify(opts.pidFile ?? null)};
const lifetimeMs = ${lifetimeMs};
const role = process.argv[2] ?? "parent";

if (ignoreSigterm) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
if (pidFile) appendFileSync(pidFile, role + " " + process.pid + "\\n");

if (role === "parent") {
  const child = spawn(process.execPath, [process.argv[1], "grandchild"], {
    stdio: "ignore",
    detached: false,
  });
  child.unref?.();
  if (readyFile) writeFileSync(readyFile, "ready\\n");
}

// Stay alive without holding the event loop hostage to a single long timer,
// so a delivered SIGKILL is observed promptly by the test.
const started = Date.now();
const tick = setInterval(() => {
  if (Date.now() - started > lifetimeMs) {
    clearInterval(tick);
    process.exit(0);
  }
}, 100);
`, { mode: 0o755 });
  return file;
}

/** Poll a predicate until it holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
