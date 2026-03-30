# Using GitHub Copilot CLI

> Source: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli

Learn how to use GitHub Copilot from the command line.

## Using Copilot CLI

1. Navigate to a folder that contains code you want to work with.
2. Enter `copilot` to start Copilot CLI.
3. If not logged in, use `/login` and follow the on-screen instructions.
4. Enter a prompt — a chat question or a task request.
5. When Copilot wants to use a tool that could modify or execute files, it will ask for approval:
   - **Yes** — allow once
   - **Yes, and approve for the rest of the session** — allow without asking again this session
   - **No (Esc)** — reject; optionally give inline feedback so Copilot adapts

## Tips

### Stop a running operation
Press `Esc` while Copilot is "Thinking."

### Plan mode
Press `Shift+Tab` to cycle in/out of plan mode — collaborate on an implementation plan before any code is written.

### Include a specific file
Use `@` followed by the relative path: `Explain @config/ci.yml` or `Fix the bug in @src/app.js`.

### Run shell commands directly
Prepend with `!` to bypass the model: `!git clone https://github.com/...`

### Resume a session
```shell
copilot --continue      # resume most recent session
/resume                 # pick from list of sessions
```

### Custom instructions
Copilot CLI reads instructions from:
- `.github/copilot-instructions.md` — repository-wide
- `.github/instructions/**/*.instructions.md` — path-specific
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — agent instructions
- `$HOME/.copilot/copilot-instructions.md` — local/personal

### Custom agents
Use `/agent` to browse and select from available custom agents.
Or reference one in a prompt: `Use the refactoring agent to refactor this code block`
Or via CLI flag: `copilot --agent=refactor-agent --prompt "Refactor this code block"`

**Agent placement:**

| Type | Location | Scope |
|---|---|---|
| User-level | `~/.copilot/agents/` | All projects |
| Repository-level | `.github/agents/` | Current project |
| Org/Enterprise | `/agents/` in `.github-private` repo | All org/enterprise projects |

In naming conflicts: system-level > repository-level > organization-level.

### Use skills
Invoke with `/SKILL-NAME` in a prompt:
```
Use the /frontend-design skill to create a responsive navigation bar.
```

Skill commands:
```shell
/skills list        # list available skills
/skills             # toggle skills on/off
/skills info        # details + location of a skill
/skills add         # add a skills location
/skills reload      # reload after adding a skill mid-session
/skills remove SKILL-DIRECTORY
```

### Add an MCP server
```shell
/mcp add            # interactive setup
```
Config stored in `~/.copilot/mcp-config.json` (override with `COPILOT_HOME`).

### Context management
```shell
/usage     # session stats: premium requests, duration, lines edited, token breakdown
/context   # visual token usage overview
/compact   # manually compress conversation history
```
Auto-compresses at 95% of token limit.

### Enable all permissions
```shell
copilot --allow-all
copilot --yolo
```

### Toggle reasoning visibility
Press `Ctrl+T` to show/hide model reasoning. Persists across sessions.

## Find out more
```shell
copilot help
copilot help config
copilot help environment
copilot help logging
copilot help permissions
```

## Built-in agents

| Agent | Description |
|---|---|
| Explore | Quick codebase analysis without adding to main context |
| Task | Executes commands (tests, builds); brief summary on success, full output on failure |
| General-purpose | Complex multi-step tasks with full toolset in separate context |
| Code-review | Reviews changes, surfaces only genuine issues |

## Agentic modes
- **Autopilot**: `Shift+Tab` to cycle modes — completes multi-step tasks without per-step approval
- **Delegate to GitHub**: `/delegate` — sends session to GitHub, Copilot creates a PR
- **Fleet mode**: `/fleet` — parallel subagent execution
- **Background tasks**: `/tasks` — view and manage background subagent tasks

## Further reading
- [Best practices for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
