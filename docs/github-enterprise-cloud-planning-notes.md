# GitHub Enterprise Cloud Planning Notes (Deferred)

Status: Deferred pending full GitHub Enterprise access and environment details.

Date noted: April 21, 2026

## Why this is deferred

- The kit can continue to run with the current local/runtime model.
- A proper cloud-agent design requires enterprise-level capabilities and policy details that are not available yet.
- We should not implement partial changes without confirming enterprise constraints.

## Primary concerns to revisit

1. Registry boundary vs GitHub Issues

- Keep the registry as execution state source of truth (artifact status, claims, leases, run lifecycle, dependency gates).
- Use GitHub Issues for human workflow only (approvals, escalations, operator decisions, long-lived follow-up tasks).
- Avoid dual authority between registry and issues.
- If issue integration is added, project selected registry events to issues with stable cross references.

2. Worker execution model (local spawn vs GitHub cloud agents)

- Current worker lifecycle assumes local process spawning and local filesystem adjacency.
- A cloud-agent model requires a shared control plane and an executor abstraction.
- Do not move to distributed workers while the registry is local-only.

## Design assumptions to validate with GitHub Enterprise

- Available cloud agent runtime options and limits.
- Authentication model for agent execution and API access.
- Repo permission model for automated writes and branch protections.
- Network and secret management constraints.
- Audit/compliance requirements for agent actions and logs.

## Codespaces repository scope (needs decision)

- A Codespace is created from one primary repository context.
- Multi-repo migration workflows are still possible by cloning additional repos, but those repos do not automatically inherit primary-repo prebuilds/settings.
- We need an explicit operating model for multi-repo usage (for example, one orchestrator repo plus one or more target repos in the same Codespace).
- We need to validate cross-repo access rules in GitHub Enterprise (org boundaries, private repo permissions, token scopes).
- We should decide whether to standardize on single-repo workspace layouts to reduce operational complexity.

## Pre-implementation checklist

- Confirm enterprise-approved execution target for workers.
- Confirm whether registry may stay file-based for initial pilots or must be service-backed.
- Define issue integration policy (which events create/update issues, and ownership rules).
- Define operational limits (parallelism, timeout ceilings, retry policy) for cloud execution.
- Define minimal success criteria and rollback plan for a pilot.

## Suggested phased plan (when access is available)

1. Add executor abstraction while preserving current local execution path.
2. Prototype one cloud executor path behind a feature flag.
3. Validate claim/lease correctness under parallel cloud workers.
4. Add selective registry-to-issue projection for blocked/repeated-failure events.
5. Expand to broader rollout after pilot reliability is verified.
