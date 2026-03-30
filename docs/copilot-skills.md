# Creating Agent Skills for GitHub Copilot CLI

> Source: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-skills

Agent skills are folders of instructions, scripts, and resources that Copilot loads when relevant to improve performance on specialized tasks.

## Creating a skill

1. Create a `skills` directory in a supported location:

   | Type | Supported locations |
   |---|---|
   | Project (repo-specific) | `.github/skills/`, `.claude/skills/`, `.agents/skills/` |
   | Personal (cross-project) | `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |

2. Create a subdirectory for your skill (e.g. `.github/skills/my-skill`). Use lowercase and hyphens.

3. Create a `SKILL.md` file inside that subdirectory. **Must be named exactly `SKILL.md`.**

4. Optionally add scripts, examples, or other resources to the skill's directory.

## SKILL.md structure

YAML frontmatter + Markdown body:

```markdown
---
name: my-skill-name          # required; lowercase, hyphens for spaces
description: What the skill does and when Copilot should use it.   # required
license: MIT                 # optional
---

Markdown instructions for Copilot...
```

## Example SKILL.md

```markdown
---
name: github-actions-failure-debugging
description: Guide for debugging failing GitHub Actions workflows. Use this when asked to debug failing GitHub Actions workflows.
---

To debug failing GitHub Actions workflows in a pull request:

1. Use `list_workflow_runs` to look up recent workflow runs and their status.
2. Use `summarize_job_log_failures` to get an AI summary of failed job logs.
3. If more detail is needed, use `get_job_logs` or `get_workflow_run_logs`.
4. Try to reproduce the failure in your own environment.
5. Fix the failing build and verify before committing changes.
```

## Using skills

Copilot auto-selects skills based on context. To explicitly invoke one:

```
Use the /my-skill-name skill to ...
```

### Skill CLI commands

```shell
/skills list                        # list available skills
/skills                             # toggle skills on/off interactively
/skills info                        # details and location of each skill
/skills add                         # add an alternative skills location
/skills reload                      # reload skills added mid-session
/skills remove SKILL-DIRECTORY      # remove a skill
```

## Skills vs. custom instructions

| Use | When |
|---|---|
| **Custom instructions** (`.github/copilot-instructions.md`) | Simple rules relevant to almost every task (coding standards, conventions) |
| **Skills** (`SKILL.md`) | Detailed instructions Copilot should only load when relevant to the task |

## Further reading
- [About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Comparing GitHub Copilot CLI customization features](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features)
