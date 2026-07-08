import * as fs from "fs";
import * as path from "path";
import { resolveRegistryDbPath } from "./config";

export function assertDbExists(dbPath?: string): void {
  const resolved = resolveRegistryDbPath({ explicitPath: dbPath });
  if (!fs.existsSync(resolved)) {
    process.stderr.write(
      `\n  ✗ Registry not found: ${resolved}\n\n` +
      `  Run inventory first to initialise the registry:\n` +
      `    node migration/guildctl/dist/cli.js inventory\n\n`
    );
    process.exit(1);
  }
}

export function getLogDir(): string {
  const dir = path.resolve(process.cwd(), "migration", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
