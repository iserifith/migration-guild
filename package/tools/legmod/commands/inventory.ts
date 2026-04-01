import type Database from "better-sqlite3";
import { spawnCopilot } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";

export async function runInventory(db: Database.Database): Promise<void> {
  printPhaseHeader("Phase 1 · Inventory");
  console.log("  Agent: context-agent   Model: gpt-5-mini\n");

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const code = await spawnCopilot({
    agent: "context-agent",
    model: "gpt-5-mini",
    prompt: "Run inventory on all Java files in legacy/",
    db,
    logDir: getLogDir(),
  });

  stopPolling();
  printStatusSummary(db);

  if (code !== 0) {
    process.stderr.write(`\n  ✗ Inventory exited with code ${code}\n`);
    process.exit(code);
  }
  console.log("\n  ✓ Inventory complete\n");
}
