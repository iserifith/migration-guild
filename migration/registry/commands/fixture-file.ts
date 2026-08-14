import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CharacterizationFixture {
  seam: string;
  input: unknown;
  output: unknown;
  capturedAt: string;
  contentSha256: string;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

export interface WriteFixtureFileOptions {
  dir: string;
  /** File-naming key, independent of the evidence row's own generated ID —
   * the caller typically supplies a fresh random UUID. */
  id: string;
  seam: string;
  input: unknown;
  output: unknown;
}

/**
 * Writes a captured characterization fixture to disk and returns its path plus
 * the content hash of `output`, which the caller records on the evidence row
 * (FR-004: every fixture must identify seam, input, output, and a content hash).
 */
export function writeFixtureFile(opts: WriteFixtureFileOptions): { path: string; contentSha256: string } {
  fs.mkdirSync(opts.dir, { recursive: true });
  const contentSha256 = sha256Json(opts.output);
  const fixture: CharacterizationFixture = {
    seam: opts.seam,
    input: opts.input,
    output: opts.output,
    capturedAt: new Date().toISOString(),
    contentSha256,
  };
  const filePath = path.join(opts.dir, `${opts.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2), "utf8");
  return { path: filePath, contentSha256 };
}

export function readFixtureFile(filePath: string): CharacterizationFixture {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as CharacterizationFixture;
}
