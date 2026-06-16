# Guildctl Pitch Sections (Narrative Draft)

Source baseline: `docs/presentation/Guildctl_Pitch_Deck.pdf` outline/bookmarks, rewritten into section text.

## Intro

### Guildctl Pitch Overview and Vision

- Legacy Code Modernization Challenge
  - Legacy Java systems are complex and poorly documented, making modernization risky, expensive, and slow.
- Why This Matters Now
  - Teams need to upgrade frameworks and runtime stacks, but manual migration cannot scale across large codebases.
- Guildctl's Vision and Approach
  - Guildctl acts as an AI-assisted migration control tower that organizes work into reliable phases instead of one-off code generation.

## Problem Statement

### The Legacy Modernization Challenge

- Fragmented migration process
  - Analysis, planning, code rewrite, and validation are often disconnected, creating rework and defects.
- Operational risk
  - Without traceable checkpoints, teams cannot confidently track what changed, why it changed, or whether it is safe.
- Cost and timeline pressure
  - Migration projects consume senior engineering time and can stall business roadmap execution.

## Solution

### Opportunity and Solution

- Migration Control Tower Opportunity
  - A phased orchestration model can reduce uncertainty by forcing sequence, ownership, and validation across the full migration lifecycle.
- Guildctl as an AI-assisted Migration Toolkit
  - Specialized agents and reusable skills handle targeted tasks while a registry coordinates status and handoffs.
- Quality by design
  - Planning gates, evaluation checks, and remediation loops ensure output quality is measurable and recoverable.

## Demo (Video, Max 3 Minutes) (Pending)

### Execution and Demonstration

- Demo objective
  - Show that Guildctl can move from discovery to reviewed output with visible, traceable progress.

### Four Core Stages

- Discovery / Inventory
  - Guildctl scans legacy artifacts, classifies roles/framework hints, and builds a structured migration inventory.
- Planning
  - Stack choices, dependency strategy, and wave planning are confirmed before code generation begins.
- Execution
  - Analyzer, test-writer, and code-writer agents run in coordinated parallel lanes to accelerate migration.
- Review
  - Review agents and evaluators mark artifacts as reviewed or needs-rework, enabling deterministic follow-up.

### Product Demo Story and Traceable Progress

- Live status and blockers
  - Watch mode and registry outputs show active progress, blockers, and current pipeline health.
- Recovery behavior
  - Needs-rework artifacts can be rerun without restarting the entire migration, proving operational resilience.

## Differentiation and Impact

### Why Guildctl Wins

- More than code generation
  - Guildctl provides orchestration, governance, and traceability, not just transformed files.
- Defensible architecture
  - Agent specialization plus shared skills improves consistency and lowers prompt drift risk.
- Operational confidence
  - Registry-first state tracking gives teams auditable evidence for each migration step.

### Measured Impact for Engineering Teams

- Throughput improvement
  - Parallelized execution increases migration velocity compared with manual, serial workflows.
- Quality control
  - Evaluators and review checkpoints reduce silent regressions and support safer rollout.
- Team productivity
  - Engineers focus on edge-case decisions while routine migration work is automated.

### How It Works

- Orchestrated core loop
  - Guildctl runs a phased loop of discovery, planning, execution, and review with clear handoff criteria.
- Specialized agents with shared state
  - Purpose-built agents handle focused tasks while a central registry coordinates artifact status and parallel work.
- Reusable skills for repeatability
  - Skills encode migration best practices so output quality is consistent instead of dependent on ad-hoc prompting.
- Quality gates and recovery path
  - Evaluation checks block unsafe progression and route failed artifacts into targeted rework and rerun paths.
- Auditability by design
  - Every artifact transition is traceable, giving teams evidence for what changed, when, and why.
- Flexible pipeline extension
  - Teams can insert additional controls such as risk profiling, security/compliance gates, architecture checks, and cost-budget policies without redesigning the core flow.

## Conclusion

### Future and Call to Action

- Near-term roadmap
  - Expand enterprise rollout patterns, improve reporting, and tighten feedback loops from production usage.
- Business potential
  - Modernization demand is persistent and high-value, making Guildctl relevant across many engineering organizations.

### The Ask: Proving Guildctl in the Real World

- Pilot request
  - Partner on a real migration pilot to validate speed, quality, and operational fit on production-like codebases.
- Success criteria
  - Measure cycle time, review pass rate, and rework reduction to quantify ROI.
