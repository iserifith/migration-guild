# 0002 — Align Migration Guild to Track 3: Agent Society

Status: Accepted  
Date: 2026-06-16

## Decision

Align **Migration Guild** to **Track 3: Agent Society**.

Migration Guild is not pitched as a generic migration CLI. It is pitched as a governed multi-agent society where software modernization is the proving arena because modernization naturally requires specialization, division of labor, disagreement, evidence, and acceptance control.

## Track Thesis

Migration Guild demonstrates an agent society by using a shared blackboard registry where specialized agents coordinate through artifacts, claims, event logs, evidence records, and approval gates.

The central product claim is:

> Migration Guild turns legacy modernization into a governed agent society: Builders can propose work, Critics must produce executable evidence, and Arbiters approve only from recorded proof.

## Required Track 3 Proof Points

Migration Guild must visibly demonstrate:

1. **Distinct agent capabilities**
   - Surveyor / inventory agent identifies artifacts.
   - Stack Advisor proposes modernization strategy.
   - Planner assigns waves and dependencies.
   - Analyzer interprets a selected artifact.
   - Test Writer creates preservation tests.
   - Builder / Code Writer migrates code.
   - Critic / Reviewer checks migration quality.
   - Arbiter enforces acceptance from evidence.
   - Remediation Agent handles failed or stuck work.

2. **Task division and role assignment**
   - Registry artifacts, waves, dependency readiness, and lease-backed claims are the task market.
   - Agents claim only work matching their phase and artifact status.

3. **Dialogue / negotiation**
   - Agent dialogue is expressed as registry events and evidence records, not chat theater.
   - Agents propose, block, reject, release, remediate, and approve through auditable blackboard state.

4. **Disagreement / conflict resolution**
   - Builder completion is only a proposal.
   - Critic can reject with failing evidence.
   - Arbiter decides from executable proof, not from Builder self-report.
   - Claim leases and stale-run reaping resolve execution conflicts.

5. **Measurable gain over a single-agent baseline**
   - Demo must compare Guild mode against a single-agent baseline on the same modernization fixture.
   - Required metrics: completion rate, passing preservation checks, rework count, elapsed time, and/or cost.

## Product Boundary

Optimize the next implementation for **Agent Society demonstration first, modernization breadth second**.

This means the next build should prioritize:

- explicit evidence gate,
- visible arbitration trail,
- conflict/rework path,
- dashboard/CLI story for agent society behavior,
- baseline-vs-guild measurement.

Do not expand into broad demo content, additional frameworks, or deep migration sophistication until the society proof is visible.

## Non-Goals

- Do not build a general-purpose multi-agent chat room.
- Do not add human approval as the only Arbiter mechanism.
- Do not let the Builder mark work accepted/completed directly.
- Do not optimize the legacy modernization demo slice before evidence/arbitration is proven.
- Do not remove existing blackboard/claim machinery; extend it.

## Implementation Source of Truth

The implementation plan is:

```text
docs/plans/0002-track-3-agent-society-evidence-gate.md
```
