import type {
  AcceptanceEvidenceRow,
  SocietyLane,
  SocietyLifecycle,
} from "../types";

export interface SocietyFixture {
  lanes: SocietyLane[];
  lifecycles: SocietyLifecycle[];
  initialArtifactId: string;
}

const evidence = (
  evidenceId: string,
  pass: 0 | 1,
  command: string,
  exitCode: number,
  summary: string,
): AcceptanceEvidenceRow => ({
  evidence_id: evidenceId,
  artifact_id: "chainr",
  run_id: `run-${evidenceId}`,
  produced_by: "critic-1",
  evidence_type: command === "npm test" ? "test-command" : "build-command",
  command,
  exit_code: exitCode,
  pass,
  summary,
  output_path: null,
  output_excerpt: null,
  created_at: "2026-06-27T08:00:00Z",
});

export const societyFixture: SocietyFixture = {
  initialArtifactId: "chainr",
  lanes: [
    {
      role: "builder",
      activeLabel: "3 active",
      artifacts: [
        { artifactId: "chainr", name: "Chainr", agentId: "code-writer-1", state: "claimed 2m" },
        { artifactId: "joinr", name: "Joinr", agentId: "code-writer-3", state: "writing tests" },
      ],
    },
    {
      role: "critic",
      activeLabel: "2 active",
      artifacts: [
        { artifactId: "chainr", name: "Chainr", agentId: "critic-1", state: "evidence PASS" },
        { artifactId: "diffy", name: "Diffy", agentId: "critic-2", state: "evidence PASS" },
      ],
    },
    {
      role: "arbiter",
      activeLabel: "1 pending",
      artifacts: [
        { artifactId: "diffy", name: "Diffy", agentId: null, state: "awaiting decision" },
        { artifactId: "removr", name: "Removr", agentId: null, state: "back to rework", rejected: true },
      ],
    },
  ],
  lifecycles: [
    {
      artifactId: "chainr",
      artifactName: "Chainr",
      status: "accepted · reviewed",
      steps: [
        {
          id: "proposed",
          kind: "builder",
          title: "Builder proposed migration",
          relativeTime: "8m",
          description: "code-writer-1 moved artifact to migrated — a proposal, not acceptance",
        },
        {
          id: "failed-evidence",
          kind: "critic",
          title: "Critic submitted evidence",
          relativeTime: "7m",
          evidence: [evidence("e10", 0, "npm test", 1, "2 failing")],
        },
        {
          id: "rejected",
          kind: "rejection",
          title: "Arbiter rejected",
          relativeTime: "7m",
          description: "guildctl-arbiter → needs-rework · behavior drift on null key",
        },
        {
          id: "reworked",
          kind: "builder",
          title: "Builder re-migrated",
          relativeTime: "4m",
          description: "code-writer-1 reclaimed and fixed the null-key path",
        },
        {
          id: "passing-evidence",
          kind: "critic",
          title: "Critic submitted evidence",
          relativeTime: "2m",
          evidence: [
            evidence("e11", 1, "npm test", 0, "Passing test suite"),
            evidence("e12", 1, "gradle build", 0, "Successful build"),
          ],
        },
        {
          id: "gate",
          kind: "gate",
          title: "Gate: independent passing evidence — producer critic-1 ≠ arbiter",
        },
        {
          id: "accepted",
          kind: "arbiter",
          title: "Arbiter accepted",
          relativeTime: "1m",
          decision: {
            decision_id: "d12",
            artifact_id: "chainr",
            arbiter: "guildctl-arbiter",
            decision: "approved",
            reason: "Independent proof supplied",
            evidence_ids: "e11,e12",
            decided_at: "2026-06-27T08:07:00Z",
          },
        },
      ],
    },
    {
      artifactId: "removr",
      artifactName: "Removr",
      status: "rejected · needs rework",
      steps: [
        { id: "removr-proposed", kind: "builder", title: "Builder proposed migration", relativeTime: "5m" },
        {
          id: "removr-failed",
          kind: "critic",
          title: "Critic submitted evidence",
          relativeTime: "3m",
          evidence: [{ ...evidence("e20", 0, "npm test", 1, "Null behavior mismatch"), artifact_id: "removr" }],
        },
        {
          id: "removr-rejected",
          kind: "rejection",
          title: "Arbiter rejected",
          relativeTime: "2m",
          description: "Returned to Builder for rework",
        },
      ],
    },
  ],
};
