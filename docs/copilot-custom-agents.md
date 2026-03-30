# Creating Custom Agents for Copilot

> Source: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents

Custom agents allow you to tailor Copilot's expertise for specific tasks using Markdown agent profile files (`.agent.md`).

## Agent profile locations

| Type | Location | Scope |
|---|---|---|
| User-level | `~/.copilot/agents/` | All projects |
| Repository-level | `.github/agents/` | Current project |
| Org/Enterprise | `/agents/` in `.github-private` repo | All org/enterprise projects |

In naming conflicts: system-level > repository-level > organization-level.

## Configuring an agent profile

Agent profiles are Markdown files with YAML frontmatter (`.agent.md` extension). Filename may only contain: `.`, `-`, `_`, `a-z`, `A-Z`, `0-9`.

### YAML frontmatter properties

| Property | Required | Description |
|---|---|---|
| `name` | No | Display name. Defaults to filename (without `.agent.md`). |
| `description` | **Yes** | What the agent does and when to use it. |
| `tools` | No | List of tool names the agent can use. Omit for all tools. |
| `mcp-servers` | No | MCP servers available only to this agent. |
| `model` | No | AI model to use (VS Code, JetBrains, Eclipse, Xcode only). |
| `target` | No | `vscode` or `github-copilot` to restrict to one environment. |
| `agents` | No | List of agents this agent can hand off to. |

The Markdown body below the frontmatter is the agent's prompt (max 30,000 characters).

## Example: Testing specialist (all tools enabled)

```markdown
---
name: test-specialist
description: Focuses on test coverage, quality, and testing best practices without modifying production code
---

You are a testing specialist focused on improving code quality through comprehensive testing. Your responsibilities:

- Analyze existing tests and identify coverage gaps
- Write unit tests, integration tests, and end-to-end tests following best practices
- Review test quality and suggest improvements for maintainability
- Ensure tests are isolated, deterministic, and well-documented
- Focus only on test files and avoid modifying production code unless specifically requested

Always include clear test descriptions and use appropriate testing patterns for the language and framework.
```

## Example: Implementation planner (restricted tools)

```markdown
---
name: implementation-planner
description: Creates detailed implementation plans and technical specifications in markdown format
tools: ["read", "search", "edit"]
---

You are a technical planning specialist focused on creating comprehensive implementation plans. Your responsibilities:

- Analyze requirements and break them down into actionable tasks
- Create detailed technical specifications and architecture documentation
- Generate implementation plans with clear steps, dependencies, and timelines
- Document API designs, data models, and system interactions
- Create markdown files with structured plans that development teams can follow

Always structure your plans with clear headings, task breakdowns, and acceptance criteria.
```

## Using custom agents in CLI

```shell
/agent                                          # browse and select from list
copilot --agent=my-agent --prompt "Do X"        # specify via CLI flag
"Use the my-agent agent to do X"                # reference in natural language
```

## Further reading
- [Custom agents configuration reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Your first custom agent (tutorial)](https://docs.github.com/en/copilot/tutorials/customization-library/custom-agents/your-first-custom-agent)
- [awesome-copilot agent examples](https://github.com/github/awesome-copilot/tree/main/agents)
