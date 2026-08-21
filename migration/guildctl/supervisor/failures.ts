export type FailureKind =
  | "build-failure"
  | "test-failure"
  | "agent-timeout"
  | "review-rejection"
  | "filesystem-violation"
  | "claim-violation"
  | "stack-mismatch"
  | "pack-defect"
  | "provider-error"
  | "unknown";

export interface FailureInput {
  phase: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ClassifiedFailure {
  kind: FailureKind;
  phase: string;
  signature: string;
}

export function normalizeFailureSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/\/(?:tmp|var|home)\/[^\s)]+/g, "<path>")
    .replace(/[a-f0-9]{12,}/g, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyFailure(input: FailureInput): ClassifiedFailure {
  const text = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  const normalized = normalizeFailureSignature(text);
  let kind: FailureKind = "unknown";
  if (input.exitCode === 124 || /timeout|inactivity|ceiling/.test(normalized)) kind = "agent-timeout";
  else if (/review rejection|review rejected|independent review rejected|reviewer rejected/.test(normalized)) kind = "review-rejection";
  else if (/filesystem warden|unauthorized filesystem|filesystem-violation/.test(normalized)) kind = "filesystem-violation";
  else if (/claim token|active claim|claim violation|conflicting claim/.test(normalized)) kind = "claim-violation";
  else if (/stack mismatch|out-of-stack|does not match stack/.test(normalized)) kind = "stack-mismatch";
  else if (/pack defect|missing scaffold|missing template|stack pack/.test(normalized)) kind = "pack-defect";
  else if (/provider error|rate limit|429|5\d\d|api key|credential/.test(normalized)) kind = "provider-error";
  else if (/test failed|tests failed|\bfailures?:|assertionerror/.test(normalized)) kind = "test-failure";
  else if (/build failed|compilation failed|compile error|tsc|javac|maven|gradle/.test(normalized)) kind = "build-failure";
  return { kind, phase: input.phase, signature: `${kind}:${normalized}` };
}

/**
 * Optional durable seed for FailureBudget (spec 013, US3, research.md §5):
 * the artifact this run is working plus the result of
 * `getPersistedBudgetState(db, artifactId)` from registry/commands/attempts.ts
 * (`{ attemptsUsed, playbookSignatureCounts }`). Declared locally rather than
 * imported so failures.ts stays free of registry dependencies; the shapes are
 * structurally identical.
 */
export interface FailureBudgetSeed {
  artifactId: string;
  attemptsUsed: number;
  playbookSignatureCounts: Record<string, number>;
}

export class FailureBudget {
  private readonly attempts = new Map<string, number>();
  private readonly playbooks = new Map<string, number>();

  constructor(
    private readonly maxAttemptsPerArtifact = 3,
    private readonly maxPlaybookPerSignature = 2,
    seed?: FailureBudgetSeed,
  ) {
    // US3 (spec 013, FR-009): when given the durable state from
    // getPersistedBudgetState(), start from it instead of empty maps so a
    // restarted supervisor resumes consumed attempts/playbooks rather than
    // resetting budget. Signatures are stored under the same
    // `${artifactId}:${signature}:repair` key recordPlaybook uses: attempt
    // history records one repair playbook dispatch per failed attempt, so
    // per-signature occurrence counts are the durable form of the playbook
    // counts. No-arg construction (no seed) behaves exactly as before.
    if (seed) {
      if (seed.attemptsUsed > 0) {
        this.attempts.set(seed.artifactId, seed.attemptsUsed);
      }
      for (const [signature, count] of Object.entries(seed.playbookSignatureCounts)) {
        if (count > 0) {
          this.playbooks.set(`${seed.artifactId}:${signature}:repair`, count);
        }
      }
    }
  }

  canAttemptArtifact(artifactId: string): boolean {
    return (this.attempts.get(artifactId) ?? 0) < this.maxAttemptsPerArtifact;
  }

  recordAttempt(artifactId: string): void {
    this.attempts.set(artifactId, (this.attempts.get(artifactId) ?? 0) + 1);
  }

  canRunPlaybook(artifactId: string, failure: ClassifiedFailure, playbook: string): boolean {
    return (this.playbooks.get(this.key(artifactId, failure, playbook)) ?? 0) < this.maxPlaybookPerSignature;
  }

  recordPlaybook(artifactId: string, failure: ClassifiedFailure, playbook: string): void {
    const key = this.key(artifactId, failure, playbook);
    this.playbooks.set(key, (this.playbooks.get(key) ?? 0) + 1);
  }

  private key(artifactId: string, failure: ClassifiedFailure, playbook: string): string {
    return `${artifactId}:${failure.signature}:${playbook}`;
  }
}
