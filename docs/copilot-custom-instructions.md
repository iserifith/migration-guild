# Adding Custom Instructions for GitHub Copilot CLI

> Source: https://docs.github.com/en/copilot/how-tos/copilot-cli/add-custom-instructions

Custom instructions give Copilot persistent context about your project, team conventions, and tools — automatically included in every prompt without you having to repeat them.

## Types of custom instructions

### 1. Repository-wide instructions
**File:** `.github/copilot-instructions.md`  
**Scope:** All requests in the context of the repository.

### 2. Path-specific instructions
**Files:** `.github/instructions/**/*.instructions.md`  
**Scope:** Requests involving files matching the `applyTo` glob pattern.

Frontmatter format:
```markdown
---
applyTo: "src/**/*.ts,src/**/*.tsx"
---

Your instructions here...
```

Optionally exclude from specific agents:
```markdown
---
applyTo: "**"
excludeAgent: "code-review"    # or "coding-agent"
---
```

Glob examples:
- `*` — all files in current directory
- `**` or `**/*` — all files in all directories
- `**/*.py` — all `.py` files recursively
- `src/**/*.py` — all `.py` files under `src/` recursively

### 3. Agent instructions
**Files:** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`  
**Scope:** Used by AI agents.

- `AGENTS.md` at repo root = primary instructions
- Both `AGENTS.md` and `.github/copilot-instructions.md` at root = both are used
- `AGENTS.md` in subdirectories = additional instructions (lower priority than root)
- `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var = comma-separated list of additional directories to scan

### 4. Local/personal instructions
**File:** `$HOME/.copilot/copilot-instructions.md`  
**Scope:** Your local environment, all projects.

## All locations Copilot checks (in order of precedence)

```
CLAUDE.md
GEMINI.md
AGENTS.md                               (git root & cwd)
.github/instructions/**/*.instructions.md
.github/copilot-instructions.md
$HOME/.copilot/copilot-instructions.md
COPILOT_CUSTOM_INSTRUCTIONS_DIRS        (env var, additional dirs)
```

## Writing effective instructions

- Use natural language, Markdown format
- Whitespace between instructions is ignored
- Instructions are automatically included — not displayed to you but available to Copilot
- Changes take effect on the next prompt in the current or future sessions

## Further reading
- [Support for different types of custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [Custom instructions examples (curated library)](https://docs.github.com/en/copilot/tutorials/customization-library/custom-instructions)
- [Using custom instructions to unlock the power of Copilot code review](https://docs.github.com/en/copilot/tutorials/use-custom-instructions)
