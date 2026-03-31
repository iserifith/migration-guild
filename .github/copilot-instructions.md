# Copilot Instructions

This repository authors a **Copilot CLI customization kit** for Java legacy-to-modern migration projects. The target framework is determined by the legacy project type — not assumed upfront:

- **Web apps** (JAX-RS, servlets) → Spring Boot 3.x with `spring-boot-starter-web`
- **Services / batch / CLI** → Spring Boot 3.x with `spring-boot-starter` (no embedded server)
- **Libraries / utilities** → Plain Java 17+ with JUnit 5, no Spring Boot

## Purpose

The deliverables in this repo are designed to be cloned into a target Java project and provide Copilot with the agents, skills, prompts, and instructions needed to drive a structured migration workflow. The repo itself is an authoring workspace — nothing here runs in production.

## Deliverables

- **Agent profiles** (`.agent.md`) — specialist agents covering analysis, migration execution, review, and orchestration
- **Skills** (`SKILL.md`) — reusable skill packages Copilot loads when relevant to a task
- **Prompt files** (`.prompt.md`) — human-facing entrypoints for common migration tasks
- **Path instructions** (`*.instructions.md`) — context rules that activate automatically based on file path
- **Registry CLI** (TypeScript) — a SQLite-backed tool for tracking migration artifact state across agent sessions

## Conventions

Follow the official GitHub Copilot CLI docs in `docs/` when authoring any of the above. Key references:
- Agent profiles → `docs/copilot-custom-agents.md`
- Skills → `docs/copilot-skills.md`
- Instructions → `docs/copilot-custom-instructions.md`
- General CLI usage → `docs/copilot-cli-usage.md`
