import type { MissionControlData } from "../types";
export type MissionControlFixture = MissionControlData;

export const missionControlFixture: MissionControlFixture = {
  metrics: [
    { label: "Completion", value: "68%", detail: "17 / 25 artifacts", tone: "neutral" },
    { label: "Evidence pass rate", value: "92%", detail: "23 of 25 proofs", tone: "success" },
    { label: "Awaiting arbitration", value: "3", detail: "Proof ready, unjudged", tone: "warning" },
    { label: "Throughput", value: "4.2", suffix: "/hr", detail: "Last 60 min", tone: "neutral" },
  ],
  society: [
    { role: "builder", action: "Proposes → migrated", count: "3 active" },
    { role: "critic", action: "Runs tests → evidence", count: "2 active" },
    { role: "arbiter", action: "Accepts from proof", count: "1 pending" },
  ],
  waves: [
    { label: "Wave 1", status: "8/8 done", progress: 100, tone: "success" },
    { label: "Wave 2", status: "9/12 active", progress: 75, tone: "accent" },
    { label: "Wave 3", status: "Blocked · dependency", progress: 8, tone: "warning" },
  ],
  activity: [
    { id: "activity-arbiter-accepted-chainr", role: "Arbiter", message: "accepted Chainr", relativeTime: "2s", tone: "arbiter" },
    { id: "activity-critic-proof-shiftr", role: "Critic", message: "proof passed · Shiftr", relativeTime: "11s", tone: "critic" },
    { id: "activity-arbiter-rejected-removr", role: "Arbiter", message: "rejected Removr", relativeTime: "38s", tone: "danger" },
    { id: "activity-builder-claimed-sortr", role: "Builder", message: "claimed Sortr", relativeTime: "1m", tone: "builder" },
  ],
};
