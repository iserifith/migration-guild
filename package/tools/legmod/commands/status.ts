import type Database from "better-sqlite3";
import { printPhaseHeader, printWavePlan, printStatusSummary, printInProgress } from "../dashboard";

export function runStatus(db: Database.Database): void {
  printPhaseHeader("Migration Status");
  printStatusSummary(db);
  printWavePlan(db);
  printInProgress(db);
  console.log();
}
