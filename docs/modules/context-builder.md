# Context Builder — how per-artifact context packets reach LLM agents

> Cartographer deep-dive. Everything below is grounded in code on `main` as of
> Aug 2026. Cite paths are relative to the repo root.

## Purpose / overview

Migration Guild moves legacy files (e.g. Java) to a target stack using pools of
LLM agents. The "context builder" is not one monolithic function; it is a small
pipeline of cooperating pieces that together assemble what each agent needs to
know about **one artifact** before it starts working:

1. **Producer side** — an upstream agent (almost always `analyze-agent`) reads
   the legacy source file, distills it into a structured markdown "context
   file", and persists it into the registry via
   `migration/registry/commands/context.ts:writeContext`.
2. **Storage** — the context file is copied into the workspace under
   `migration/artifacts/<slug>/context/<agent>.md` and indexed in the SQLite
   `agent_context` table (`migration/registry_schema.sql:160`), keyed by
   `(artifact_id, agent)` with an extracted `## Summary` blob.
3. **Consumer side** — downstream agents (`test-writer-agent`,
   `code-writer-agent`, …) resolve the packet with
   `migration/registry/commands/context.ts:getContextPath`, read the file, and
   treat it as the behavioral contract for their work.
4. **Orchestration-side prompt assembly** — the runner (`guildctl`) builds the
   *outer* prompt from config snapshot + evidence + stack-pack instructions;
   the per-artifact context file is fetched *by the agent itself* through the
   registry CLI rather than being inlined into the spawn prompt.

There is **no RAG / vector retrieval anywhere in this flow**. Context is
assembled deterministically from: the registry DB, the source tree read
directly by agents, prior agent-written context files, dependency info stored
in registry tables, and static stack-pack YAML/instruction files.

## Architecture

```
 analyze-agent ──writes──▶ temp .md ──writeContext()──▶ migration/artifacts/<slug>/context/analyze-agent.md
                                                        + agent_context row (artifact_id, agent, path, summary)
                                                                            │
 test-writer-agent / code-writer-agent ──getContextPath()──▶ file_path ──▶ agent reads file ◀── legacy source tree
      ▲                                                                      ▲
      └── spawn prompt (runner.ts) ◀── renderPrompt()/stack-pack instructions (guildctl/workspace.ts, guildctl/stack.ts)
```

Key modules:

| Role | File |
|---|---|
| Persist / resolve context | `migration/registry/commands/context.ts` |
| CLI surface | `migration/registry/cli.ts` (`write-context`, `get-context-path`) |
| Storage schema | `migration/registry_schema.sql` (`agent_context` table) |
| Read-only surfacing | `migration/registry/commands/queries.ts:showFileStatus` |
| Outer prompt assembly | `migration/guildctl/workspace.ts:renderPrompt` |
| Stack-pack instructions | `migration/guildctl/stack.ts:readStackInstruction` |
| Orchestration wiring | `migration/guildctl/commands/migrate.ts:runMigrate` |
| Agent playbooks (consumers/producers) | `package/agents/*.agent.md` |

## Step-by-step flow

### 1. Claim & read (producer)

`analyze-agent` claims exactly one `planned` first-class artifact (or receives
a pre-claim via `GUILDCTL_ARTIFACT_ID` env injected by
`migration/guildctl/runner.ts`), then reads the legacy file directly from the
source tree. The playbook (`package/agents/analyze-agent.agent.md`) tells it to
extract responsibility, public method behaviors, annotations, dependencies,
edge cases, and externalized config values.

### 2. Compose the context file (producer)

The agent writes a compact markdown file to a **temporary path** with two
required parts:

```markdown
## Summary
<concise test-oriented summary>

## Structured Context
```json
{ "id": "...", "path": "...", "responsibility": "...",
  "methods": [{"name": "...", "behavior": "..."}],
  "annotations": [...], "dependencies": [...], "config": [...],
  "edgeCases": [...], "testCases": [...], "notes": "..." }
```
```

### 3. Persist — `writeContext` (`migration/registry/commands/context.ts:20`)

```ts
export function writeContext(db, id, agent, filePath): void {
  validateId(id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id))
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  ...
  const summary = extractSummary(content);        // throws if no "## Summary"
  const slug = idToSlug(id);
  const destDir = path.join("migration", "artifacts", slug, "context");
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `${agent}.md`);
  fs.copyFileSync(filePath, destFile);
  db.prepare(`INSERT INTO agent_context (...) VALUES (...)
              ON CONFLICT (artifact_id, agent) DO UPDATE SET ...`).run(...);
}
```

Details worth knowing:

- `validateId` (`migration/registry/types.ts:407`) enforces the
  `<kind>:<module>:<ClassName>` three-part ID; `idToSlug`
  (`types.ts:403`) lowercases and maps `:` → `--`
  (`legacy:pcsl:Foo` → `legacy--pcsl--foo`).
- `extractSummary` (`context.ts:7`) regex-extracts the first `## Summary`
  section; a missing section is a hard `RegistryError(1)` — the file is never
  copied.
- Upsert on `(artifact_id, agent)` means re-running `write-context` replaces
  both the file copy and the indexed summary atomically-enough (file first,
  then row).
- Exposed as CLI: `node migration/registry/dist/cli.js write-context --id …
  --agent … --file …` (`migration/registry/cli.ts:303-313`).

### 4. Resolve — `getContextPath` (`context.ts:56`)

A single parameterized lookup:

```sql
SELECT file_path FROM agent_context WHERE artifact_id = ? AND agent = ?
```

Missing rows throw `RegistryError(2)`. CLI:
`get-context-path --id <id> --agent analyze-agent`. Downstream agents embed
exactly this call in their playbooks, e.g.
`package/agents/code-writer-agent.agent.md:44` and
`package/agents/test-writer-agent.agent.md:43`.

### 5. Outer prompt assembly (orchestrator → agent)

When `runMigrate` (`migration/guildctl/commands/migrate.ts:107`) spawns pool
agents, the *spawn prompt* is deliberately tiny — e.g. `"Write tests for next
analyzed task\n\n" + readStackInstruction(pack, "tests")` (migrate.ts:172-174).
Stack-pack instructions come from `stacks/<id>/stack.yaml`'s
`instructions:` map, loaded by `loadActiveStack` /
`readStackInstruction` (`migration/guildctl/stack.ts:129-135`). Placeholder
interpolation is locked to `{symbol,line,text,version,target}`
(`ALLOWED_PLACEHOLDERS`, stack.ts:83).

For the init/map-style modes, `renderPrompt`
(`migration/guildctl/workspace.ts:34`) stitches together: prompt template
(from `.guild/prompts/<pack>/<mode>.md` or built-in defaults), mode name, a
**sanitized** resolved-config YAML snapshot, repo context, evidence summary,
and JSON user input. Evidence itself is gathered by `collectInitEvidence`
(workspace.ts:93) — a bounded filesystem walk (`walkFiles`, max 250 entries,
skipping `.git`/`node_modules`/`dist`/…) plus git status/diff summaries.

Every rendered prompt is archived by `createRunLedger`
(workspace.ts:146) into `.guild/runs/<timestamp>/prompt.final.md`.

### 6. Consumption shape

The final "packet" an agent works from is therefore:

- the short spawn prompt (+ stack instruction text),
- its own agent playbook (`package/agents/*.agent.md`),
- the claimed artifact ID/tokens via env (`GUILDCTL_ARTIFACT_ID`, etc.),
- the per-artifact context file at `getContextPath(...)`, containing Summary +
  Structured Context JSON,
- the legacy source file itself (read-only), and
- registry queries for dependencies/status (e.g. `showFileStatus` in
  `queries.ts:262` returns `{ artifact, tags, recent_events, agent_context }`).

## Invariants & edge cases

- **Artifact must exist**: `writeContext` refuses unknown IDs
  (`RegistryError(2)`).
- **Summary is mandatory**: no `## Summary` heading → nothing is persisted
  (`extractSummary` throws before any file copy).
- **One context file per (artifact, agent)**: primary key
  `(artifact_id, agent)`; later writes overwrite earlier ones — there is no
  version history of context packets.
- **ID format gate**: `validateId` requires exactly 3 non-empty colon-separated
  parts.
- **No size/token limits enforced in code.** There is no truncation, redaction,
  or token budgeting in `writeContext`/`renderPrompt`. The only size control is
  the *convention* "keep analysis concise" in the agent playbooks and the
  250-file cap in `walkFiles` for init evidence. Config carries a
  `context_length` field (`migration/guildctl/config.ts:13`, default 131072)
  but it is model metadata, not an assembler-side limit.
- **Warden protection**: the filesystem warden treats
  `migration/artifacts/*/context/**` as registry-owned runtime state and will
  not flag/revert it — see `migration/guildctl/warden.ts:85` and the test
  `migration/test/warden.test.ts:168` ("filesystem warden preserves
  registry-owned migration artifact context").
- **Relative destination paths**: `destDir` is built relative to the process
  CWD (`path.join("migration", "artifacts", ...)`), so `write-context` must be
  run from the workspace root.
- **JSON in `event_data` vs context**: events parse JSON defensively
  (`queries.ts:95`), but the Structured Context JSON inside the context file is
  parsed by consuming agents, not validated by the registry — malformed JSON
  passes through silently.

## Gotchas

- The registry stores only the **path string**, not the content. If the file
  under `migration/artifacts/<slug>/context/` is deleted or the workspace is
  relocated, `getContextPath` still returns a stale path pointing at nothing.
- `agent` is cast unchecked at the CLI boundary
  (`opts.agent as Agent` in `cli.ts:310,320`); the DB accepts any string even
  though `Agent` is a closed union (`migration/registry/types.ts:89`).
- Consumers hardcode `--agent analyze-agent`: test/code writers always read the
  *analyzer's* packet. A context written by any other agent is invisible to
  them unless a playbook changes.
- Two parallel vocabularies exist: `context-agent` (inventory/classification
  phase, see `package/agents/context-agent.agent.md` and
  `migration/guildctl/commands/inventory.ts:356`) vs. the per-artifact
  `write-context` pipeline above. They share a name, not machinery.
- Prompt templates are user-editable (`.guild/prompts/...` shadows built-ins in
  `loadPromptTemplate`, workspace.ts:26); a broken template silently changes
  every packet.

## Extension points

- **New producer/consumer pairs**: add the agent literal to the `Agent` union
  (`migration/registry/types.ts:89`) and a playbook in `package/agents/`;
  `writeContext`/`getContextPath` need no changes (schema already keys on
  arbitrary agent strings).
- **Richer packets**: extend the Structured Context JSON shape in
  `analyze-agent.agent.md`; consumers are playbooks, so no code change is
  required — but note the registry never validates the JSON.
- **Stack-specific guidance**: add/extend `instructions:` entries in a
  `stacks/<id>/stack.yaml` and reference them via `readStackInstruction(pack,
  kind)` when composing prompts (pattern used in `migrate.ts:173`).
- **Centralized assembly**: if packets ever need server-side composition
  (token budgets, redaction), `renderPrompt` + `showFileStatus` are the natural
  seams — today they are independent.

## Related tests

- `migration/test/warden.test.ts` — warden must preserve
  `migration/artifacts/*/context/` files.
- `migration/test/stack-pack-engine.test.ts` and
  `migration/test/stack-pack-pylons.test.ts` — placeholder interpolation and
  pack loading rules feeding instructions into prompts.
- `migration/test/registry-api-queries.test.ts` — query-layer behavior around
  artifacts/events surfaced alongside `agent_context`.
