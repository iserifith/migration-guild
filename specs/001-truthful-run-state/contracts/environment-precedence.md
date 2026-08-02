# Contract: Environment Precedence and Divergence Reporting

**Interface**: the process environment a phase run and its agents receive, and the divergence report
printed at run start. **Requirements**: FR-020–FR-026.

**Status**: this is the one **intended behaviour change** in the feature. It was settled as a product
decision before specification (spec § Assumptions) and is not reopened here. FR-026 exists precisely
because it changes behaviour.

---

## A. Precedence rule

| Mode | Trigger | Winner |
|------|---------|--------|
| `project` (**default**) | none — this is the default | project-local `.env` value wins over the inherited/ambient value |
| `ambient` | `GUILD_ENV_PRECEDENCE=ambient`, or the `--ambient-env` global flag | ambient value wins |

**Absent the explicit opt-in, an ambient value MUST NOT override a project-local value** (FR-021).

**Bootstrap rule**: the mode is read **only** from the ambient environment snapshot and the CLI flag —
never from a `.env` file. A project file cannot grant itself ambient precedence, and cannot switch the
mode that decides its own precedence.

---

## B. Loading algorithm

```text
1. snapshot ambient process.env               ← before any file is read; this is the comparison basis
2. for each candidate .env, in existing order:
       parse with dotenv.parse (no side effects)
       first file to define a variable wins among files
3. compute the divergence set                 ← always, before either side is applied
4. apply precedence:
       mode = project  → project values overwrite ambient
       mode = ambient  → ambient values retained
5. emit the divergence report                 ← always, regardless of winner or mode
```

**Candidate order is unchanged** for loading project values: the workspace `<cwd>/.env` is the only
project-local candidate participating in project-vs-ambient divergence and precedence. The two
CLI-install-relative candidates remain first-definition-wins compatibility inputs, but are excluded
from the project-local divergence set and do not override ambient values. This keeps the intended
behaviour change scoped to the workspace checkout.

**Why not `dotenv`'s `override: true`**: it would silently flip precedence *between* the three
candidate files (today the earlier file wins because dotenv does not override; with `override: true`
the last file would win), and it destroys the ambient value before anything can compare — making the
always-on divergence report impossible. Snapshot-then-apply preserves the existing inter-file
ordering and keeps both values available.

---

## C. Divergence report

A **divergence** is one variable defined in both the project-local `.env` and the inherited
environment **with differing values**. Variables present in only one source are not divergences and
are not reported. Identical values in both sources are not divergences.

**Reported always** — regardless of which source won, and regardless of whether the opt-in is active
(FR-022).

```text
[guildctl] environment: 2 divergence(s) between .env and the inherited environment
  ANTHROPIC_BASE_URL  .env=https://example-private.invalid/v1  ambient=https://api.openai.com/v1  → .env wins
  EXAMPLE_PRIVATE_API_KEY     .env=<redacted>                ambient=<redacted>                 → .env wins
```

```json
{ "mode": "project",
  "divergences": [
    { "variable": "ANTHROPIC_BASE_URL", "project_value": "https://example-private.invalid/v1",
      "ambient_value": "https://api.openai.com/v1", "winner": "project-file", "secret": false },
    { "variable": "EXAMPLE_PRIVATE_API_KEY", "project_value": "<redacted>",
      "ambient_value": "<redacted>", "winner": "project-file", "secret": true }
  ] }
```

**Rules**:

- Every divergence names the **variable**, **both values**, and the **winner** (FR-022).
- A variable carrying a credential or secret has **both values replaced with `<redacted>`**, while
  the variable name and the winner are still reported (FR-023). Secrecy is decided by the existing
  `isSensitiveEnvName` predicate in `migration/guildctl/verify.ts` — matching `API_KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `BEARER` — so one definition of "secret" governs
  evidence logs, preflight output, and this report alike.
- When there are no divergences, nothing is printed beyond the normal resolved provider/model line
  (spec edge case: "ambient opt-in enabled but no divergence exists").
- When no project `.env` exists at all, ambient values apply as before and the resolved provider and
  model are still reported at run start (spec edge case).
- The report is run output, never registry state.

---

## D. Reproducibility commitment (SC-003)

Two machines with identical checkouts and differing ambient environments resolve the **same** provider
and model on every run, unless ambient precedence is explicitly opted in. This is the property that
makes a checkout self-describing, and it is what the `env-precedence` regression suite asserts.

---

## E. Documented behaviour change (FR-026)

The following must be stated in operator-facing documentation (`README.md`,
`GETTING-STARTED.md`) **and** recorded in the maintainer changelog (`CHANGELOGS.MD` under
`Unreleased`):

1. project-local `.env` values now take precedence over inherited/ambient values by default;
2. ambient precedence requires the explicit opt-in (`GUILD_ENV_PRECEDENCE=ambient` / `--ambient-env`);
3. **this is a change in behaviour** — previously the ambient value always won silently.

The concrete migration note operators need: `.env.example` ships `AGENT_CMD`, so a workspace whose
`.env` sets `AGENT_CMD` will now use that adapter even when an ambient `AGENT_CMD` is exported. An
operator who relied on the ambient value overriding the file must either remove it from the file or
opt in to ambient precedence.

Per the constitution's Development Workflow section, changes to run-lifecycle semantics update both
maintainer docs and any external runtime architecture notes.
