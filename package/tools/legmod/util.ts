import * as fs from "fs";
import * as path from "path";
import { DEFAULT_DB_PATH } from "../registry/db/connection";

export function assertDbExists(dbPath?: string): void {
  const resolved = dbPath ?? process.env["REGISTRY_DB"] ?? DEFAULT_DB_PATH;
  if (!fs.existsSync(resolved)) {
    process.stderr.write(
      `\n  ✗ Registry not found: ${resolved}\n\n` +
      `  Run inventory first to initialise the registry:\n` +
      `    node migration/legmod/dist/cli.js inventory\n\n`
    );
    process.exit(1);
  }
}

export function getLogDir(): string {
  const dir = path.resolve(process.cwd(), "migration", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
