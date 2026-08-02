import * as fs from "fs";
import * as path from "path";
import { parse as parseDotenv } from "dotenv";
import { isSensitiveEnvName } from "./util";
import type { EnvOriginMap } from "./harness";

/**
 * Environment precedence and divergence (FR-020–FR-026), implementing
 * `specs/001-truthful-run-state/contracts/environment-precedence.md` §B.
 *
 * The workspace `.env` describes the runtime a checkout uses; absent an
 * explicit opt-in it beats the same variable inherited from the surrounding
 * shell. That is the one intended behaviour change in this feature, and it is
 * what makes a checkout self-describing (SC-003).
 *
 * The algorithm is snapshot-then-apply rather than `dotenv`'s `override: true`:
 * overriding would flip precedence *between* the candidate files (today the
 * earlier file wins) and would destroy the ambient value before anything could
 * compare, making the always-on divergence report impossible.
 *
 * Step 5 of §B — emitting the report — deliberately does not happen here.
 * `runtime-report.ts` renders it at each phase entry, so it is emitted once per
 * run rather than once per module load.
 */

export type EnvPrecedenceMode = "project" | "ambient";
export type { EnvOriginMap };

/** The literal that replaces both values of a secret-bearing variable. */
export const REDACTED = "<redacted>";

/** The global flag that opts one invocation into ambient precedence. */
export const AMBIENT_ENV_FLAG = "--ambient-env";

/** The bootstrap setting that opts into ambient precedence. */
export const ENV_PRECEDENCE_VAR = "GUILD_ENV_PRECEDENCE";

/** One variable defined in both sources with differing values (FR-022). */
export interface EnvDivergence {
  variable: string;
  /** `<redacted>` when the variable name says it carries a secret. */
  projectValue: string;
  /** `<redacted>` when the variable name says it carries a secret. */
  ambientValue: string;
  winner: "project-file" | "ambient";
  secret: boolean;
}

export interface EnvLoadResult {
  mode: EnvPrecedenceMode;
  /** Computed before either side was applied; reported regardless of winner. */
  divergences: EnvDivergence[];
  /** Origin of every variable a candidate file defined. Absent ⇒ ambient. */
  origin: EnvOriginMap;
  /** The workspace candidate considered, whether or not it exists. */
  workspaceEnvPath: string;
  /** Candidate files that existed and were parsed, in candidate order. */
  filesApplied: string[];
}

export interface LoadEnvironmentOptions {
  /** Workspace whose `.env` participates in precedence. Defaults to cwd. */
  cwd?: string;
  /**
   * CLI-install-relative compatibility candidates, in order. They keep
   * first-definition-wins semantics but never override an ambient value and
   * never enter the project-local divergence set.
   */
  installCandidates?: string[];
  /** The comparison basis. Defaults to a snapshot of the target. */
  ambient?: NodeJS.ProcessEnv;
  /** Raw argv scanned for `--ambient-env`. Defaults to `process.argv`. */
  argv?: string[];
  /** Explicit opt-in, when the caller already scanned argv itself. */
  ambientFlag?: boolean;
  /** Where resolved values are written. Defaults to `process.env`. */
  target?: NodeJS.ProcessEnv;
}

/**
 * The two CLI-install-relative candidates, covering the source
 * (`migration/guildctl/`) and built (`migration/dist/guildctl/`) layouts.
 * Preserved from the previous implicit `dotenv` auto-load so an existing
 * install keeps finding the file it always found.
 */
export function defaultInstallCandidates(dir: string = __dirname): string[] {
  return [
    path.resolve(dir, "..", "..", "..", ".env"),
    path.resolve(dir, "..", "..", ".env"),
  ];
}

/**
 * Bootstrap scan of raw argv. Commander performs the authoritative parse later;
 * this runs before module-level loading, when no parser exists yet.
 */
export function hasAmbientEnvFlag(argv: string[] = process.argv): boolean {
  return argv.includes(AMBIENT_ENV_FLAG);
}

/**
 * The mode is read **only** from the ambient snapshot and the flag. A project
 * file cannot grant itself ambient precedence, and so cannot switch the mode
 * that decides its own precedence.
 */
export function resolveEnvPrecedenceMode(
  ambient: NodeJS.ProcessEnv,
  ambientFlag: boolean,
): EnvPrecedenceMode {
  if (ambientFlag) return "ambient";
  return ambient[ENV_PRECEDENCE_VAR] === "ambient" ? "ambient" : "project";
}

function parseCandidate(file: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(file));
  } catch {
    // An unreadable candidate is not a reason to refuse to run; it simply
    // contributes nothing, exactly as a missing file does.
    return {};
  }
}

let recordedLoad: EnvLoadResult | undefined;

/** The result of the load this process performed, if it performed one. */
export function lastEnvLoad(): EnvLoadResult | undefined {
  return recordedLoad;
}

/** Origins from the recorded load; empty when no load has run. */
export function envOriginMap(): EnvOriginMap {
  return recordedLoad?.origin ?? {};
}

/** Divergences from the recorded load; empty when no load has run. */
export function envDivergences(): EnvDivergence[] {
  return recordedLoad?.divergences ?? [];
}

export function loadGuildEnvironment(options: LoadEnvironmentOptions = {}): EnvLoadResult {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? process.env;

  // 1. Snapshot the ambient environment before any file is read. This is the
  //    comparison basis, and nothing below mutates it.
  const ambient: NodeJS.ProcessEnv = { ...(options.ambient ?? target) };
  const ambientFlag = options.ambientFlag ?? hasAmbientEnvFlag(options.argv ?? process.argv);
  const mode = resolveEnvPrecedenceMode(ambient, ambientFlag);

  // 2. Parse each candidate with no side effects, first definition winning
  //    among files — the inter-file order the previous auto-load had.
  const workspaceEnvPath = path.resolve(cwd, ".env");
  const project = fs.existsSync(workspaceEnvPath) ? parseCandidate(workspaceEnvPath) : {};
  const filesApplied: string[] = fs.existsSync(workspaceEnvPath) ? [workspaceEnvPath] : [];

  const fileValues: Record<string, string> = { ...project };
  const installCandidates = (options.installCandidates ?? defaultInstallCandidates())
    .map((candidate) => path.resolve(candidate));
  for (const candidate of installCandidates) {
    // The workspace file is already accounted for; an install path that
    // resolves to it must not be counted or applied twice.
    if (candidate === workspaceEnvPath || !fs.existsSync(candidate)) continue;
    filesApplied.push(candidate);
    for (const [key, value] of Object.entries(parseCandidate(candidate))) {
      if (key in fileValues) continue;
      fileValues[key] = value;
    }
  }

  // 3. Compute the divergence set — always, and before either side is applied.
  //    Only the workspace file participates: an install-relative candidate is a
  //    compatibility input, not a description of this checkout.
  const divergences: EnvDivergence[] = [];
  for (const [variable, projectValue] of Object.entries(project)) {
    const ambientValue = ambient[variable];
    if (ambientValue === undefined || ambientValue === projectValue) continue;
    const secret = isSensitiveEnvName(variable);
    divergences.push({
      variable,
      projectValue: secret ? REDACTED : projectValue,
      ambientValue: secret ? REDACTED : ambientValue,
      winner: mode === "ambient" ? "ambient" : "project-file",
      secret,
    });
  }
  divergences.sort((a, b) => a.variable.localeCompare(b.variable));

  // 4. Apply precedence. A workspace value wins in project mode; anything else
  //    only fills a variable the ambient environment never defined, which is
  //    exactly what the non-overriding `dotenv` load used to do.
  const origin: EnvOriginMap = {};
  for (const [key, value] of Object.entries(fileValues)) {
    const ambientValue = ambient[key];
    const fileWins = ambientValue === undefined || (mode === "project" && key in project);
    if (fileWins) {
      target[key] = value;
      origin[key] = "project-file";
    } else {
      target[key] = ambientValue;
      origin[key] = "ambient";
    }
  }

  recordedLoad = { mode, divergences, origin, workspaceEnvPath, filesApplied };
  return recordedLoad;
}
