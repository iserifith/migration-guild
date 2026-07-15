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

export class FailureBudget {
  private readonly attempts = new Map<string, number>();
  private readonly playbooks = new Map<string, number>();

  constructor(
    private readonly maxAttemptsPerArtifact = 3,
    private readonly maxPlaybookPerSignature = 2,
  ) {}

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
