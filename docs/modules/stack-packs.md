# Stack Packs — the pluggable per-stack rule system

A **stack pack** is a self-contained directory under `stacks/<id>/` that teaches the otherwise
stack-agnostic `guildctl` pipeline everything it needs to know about one legacy technology: how to
detect it, inventory its files, classify each artifact, audit it for compatibility hazards,
scaffold the modern target, verify migrated artifacts, and what prose instructions the LLM agents
should receive in each phase. The repo ships exactly two packs:

- `stacks/java-spring/` — Java / Spring Boot 3 (`id: java-spring`)
- `stacks/python/` — Python 3 (`id: python`)

Both packs are pure **data**: YAML manifests, YAML rule sets, Markdown instruction prose, and
template text files. The loader code contains no stack-specific logic. This is an explicit
architectural invariant — Constitution VII, restated in a comment above `PerArtifactVerify`
(`migration/guildctl/stack.ts:62-70`): *"a per-unit compile or test invocation is stack-specific
knowledge … so it is declared here as **data**. Core reads it and executes it; core contains no
build or test command for any stack."*

## 1. Pack anatomy

Both shipped packs have an identical file structure (verified by diffing the trees):

```
stacks/<id>/
├── stack.yaml              # the manifest — everything the loader needs
├── classification.yaml     # classification vocabulary + signals (+ optional dependencies block)
├── classify.md             # operator/agent-facing prose for inventory classification
├── mappings.md             # legacy→target mapping table prose for the plan phase
├── test-convention.md      # testing convention prose for migrate-phase test agents
├── audit.rules.yaml        # regex-based source-scan audit rules
└── scaffold/               # build/settings/app/resources templates
```

The two packs differ only in content, never in shape. Notable structural deltas between
`stacks/java-spring/stack.yaml` and `stacks/python/stack.yaml`:

- `java-spring` declares two extra optional manifest blocks: `view_contract:` (OpenAPI-style view
  regeneration contract) and `logic_extraction:` (service/validator suffixes). Both are **data-only**
  on the Python side too (Python simply omits them) — see §6.
- `verify.per_artifact` differs by toolchain: `javac -proc:none -d ... {scope_paths}` vs.
  `python3 -m py_compile {scope_paths}`.

## 2. Discovery and loading (`migration/guildctl/stack.ts`)

Everything about pack I/O lives in one module, `migration/guildctl/stack.ts`.

### 2.1 Search roots

```ts
// migration/guildctl/stack.ts:222-228
function packRoots(workspaceRoot: string): string[] {
  return [...new Set([
    path.join(workspaceRoot, "stacks"),
    path.join(workspaceRoot, "package", "stacks"),
    path.resolve(__dirname, "..", "..", "stacks"),
  ])];
}
```

Three roots, deduplicated: the workspace's own `stacks/`, an installed-package copy
(`package/stacks/`), and the toolkit's shipped copy relative to the compiled bundle. A pack is any
subdirectory containing a `stack.yaml`. `listStackPacks()` enumerates them;
`loadStackPack(id, workspaceRoot)` resolves the first root that has `<root>/<id>/stack.yaml` and
throws `[guildctl] Unknown stack pack "<id>"` otherwise.

A test pins the workspace/package copies together:
`migration/test/stack-pack-engine.test.ts:146` asserts *"every `stacks/<id>/stack.yaml` is
byte-identical to its shipped `package/stacks/` copy"* — so editing one without the other fails CI.

### 2.2 Load-time validation

```ts
// migration/guildctl/stack.ts:238-250
export function loadStackPack(id: string, workspaceRoot: string): LoadedStackPack {
  ...
  const manifest = parse(fs.readFileSync(path.join(dir, "stack.yaml"), "utf8")) as StackManifest;
  const rules = parse(fs.readFileSync(path.join(dir, manifest.audit.rules_file), "utf8")) as StackAuditRule[];
  const { verify, ...interpolated } = manifest;
  validateTemplates(interpolated);
  validateTemplates(rules);
  validateVerifyTemplates(verify);
  return { dir, manifest, rules };
}
```

Two things happen at load, both deliberately eager so a malformed pack fails at startup rather than
mid-pipeline:

1. **Placeholder vocabulary check.** Every `{...}` placeholder anywhere in the manifest or rules is
   checked against the closed set `symbol | line | text | version | target`
   (`ALLOWED_PLACEHOLDERS`, stack.ts:202; `validateTemplates` recurses through strings, arrays and
   objects). An unknown placeholder throws
   `Unsupported stack-pack placeholder: {foo}` immediately. There is a dedicated test for this:
   `migration/test/stack-pack-engine.test.ts:89`.
2. **Separate verify vocabulary.** The `verify:` block uses a *different*, smaller closed set —
   `artifact_path | output_paths | dependency_paths | scope_paths | module | workspace_root`
   (`VERIFY_PLACEHOLDERS`, stack.ts:106-113). The comment is explicit about intent: *"There is
   deliberately no `{all_artifacts}`: a pack must not be able to request a tree-wide build."*
   Unknown placeholders are rejected *at pack load, not at execution time* (`validateVerifyTemplates`,
   stack.ts:152-160; tested at `stack-pack-engine.test.ts:231`).

Note what does **not** happen: there is no schema validation of the rest of the manifest. A missing
`scaffold:` or misspelled `source_globs` surfaces later as an opaque runtime error (see §7).

### 2.3 Which pack is active

`loadActiveStack(config, workspaceRoot)` simply resolves `config.stack` (the `stack:` field of the
workspace's guild config) through `loadStackPack`. That value is chosen once during `init`
(`migration/guildctl/cli.ts:130`):

```ts
const stack = opts.stack ? loadStackPack(String(opts.stack), root).manifest.id : detectStack(root);
```

`detectStack()` (stack.ts:321-327) globs `legacy/` against every pack's `detect.markers` (e.g.
Java: `pom.xml, build.gradle, build.gradle.kts, **/*.java`; Python: `pyproject.toml, setup.py,
requirements.txt, **/*.py`). Exactly one match auto-selects; zero matches throw with a hint to pass
`--stack <id>`; multiple matches also refuse to guess and demand `--stack <id>` — detection is
advisory disambiguation, never a silent coin flip.

## 3. What each file controls

### 3.1 `stack.yaml` — the manifest

Parsed into `StackManifest` (stack.ts:172-194). Field by field, with consumers:

| Field | Consumed by | Purpose |
|---|---|---|
| `id`, `display_name` | config, CLI output | Pack identity; `id` is what `--stack` accepts |
| `detect.markers` | `detectStack()` | Auto-detection globs over `legacy/` |
| `source_globs` | `countFilesForStack()`, inventory scanner | Which files are legacy source artifacts |
| `manifest_globs` | `parseDependencyVersions()` (audit.ts:26-39) | Build manifests to mine dependency versions from |
| `dependency_parsers` | same | Per-manifest-file regex with capture groups `group:artifact:version` |
| `test_framework` | declarative only | `junit5` vs `pytest`; echoed to agents via prose |
| `classification_spec` | `loadClassificationSpec()`, `loadDispositionSpec()` | Path to `classification.yaml` (required by those loaders — they throw if absent) |
| `project_types` | `bootstrap.ts` | How to pick web/library/service scaffold flavor |
| `audit.rules_file`, `audit.external_probes` | `refreshCompatibilityAudits()`, `runExternalProbes()` | Audit rules path + optional external tools |
| `verify.per_artifact` | `resolvePerArtifactVerify()` → verify.ts/auto.ts | Optional per-artifact compile check |
| `view_contract`, `logic_extraction` | **no runtime consumer** | Data-only conventions, see §6 |
| `instructions.{classify,mappings,tests}` | `readStackInstruction()` | Paths to the three Markdown instruction files |
| `scaffold` | `bootstrap.ts`, warden, inventory | Template paths, markers, directory layout |

### 3.2 `classification.yaml` — executable classification vocabulary

Loaded by `loadClassificationSpec(pack)` (`migration/guildctl/classification.ts:100-109`), which
reads `pack.dir/<manifest.classification_spec>` and runs `validateSpec()`:

- `frameworks.allowed` must be non-empty, and both `fallback` and `ambiguous` must be members;
- every signal's `framework` and `role` must be within the allowed sets.

The spec drives three mechanisms:

1. **Signals (deterministic pre-classification).** Each signal has `match.path` and/or
   `match.content` regexes plus a `framework`, `role`, optional `priority` and `confidence`.
   `classifyArtifactSource()` (classification.ts:164-210) evaluates all signals against the file's
   path and content; ties at the best (lowest) priority pointing at multiple frameworks produce an
   `ambiguous` record. Zero matches produce the fallback framework with explicit
   `negative-evidence: no configured framework signal matched` and the configured minimum
   confidence. This function doubles as an oracle: `validateInventoryQuality()` re-runs it to detect
   *"fallback classification(s) missed configured framework signal(s)"* (classification.ts:416-419).
2. **Vocabulary enforcement on agent batches.** Agents classify in batches (inventory command,
   `migration/guildctl/commands/inventory.ts:307+`); the batch JSON is validated by
   `validateBatch()`: duplicate ids rejected, unknown artifact ids rejected, roles must be in
   `roles.allowed`, frameworks normalized through `normalizeFramework()` (aliases like
   `"spring web mvc" → spring-mvc`, case-insensitive), confidence ∈ [0,1], evidence non-empty.
   Anything else throws — an agent cannot invent framework strings.
3. **Quality gates.** `spec.quality.*` tunes `validateInventoryQuality()`: max fallback percentage
   (default 50%, advisory warning unless `error`), minimum fallback confidence, required negative-
   evidence marker, tag meaningfulness. Inventory cannot complete while these fail.

Additionally, the **optional top-level `dependencies:` block** in the same file is loaded by
`loadDispositionSpec()` (`migration/guildctl/dispositions.ts:42+`) for dependency-disposition
planning. It reuses the exact parse path and rejects unknown keys with
`unknown key "dependencies.<key>"`. A pack without the block is valid: the collector degrades to
findings-derived proposals that *"fail-closed toward keep, never toward silent pruning."*

### 3.3 `classify.md`, `mappings.md`, `test-convention.md` — agent prose

Read verbatim (trimmed) by `readStackInstruction(pack, kind)` (stack.ts:256-258) and appended to
phase prompts:

- `classify.md` → inventory phase. The context-agent prompt embeds the full classification spec as
  JSON **plus** this prose (inventory.ts:368): the file itself states the division of labor —
  *"Inventory classification is governed by the stack pack's structured `classification.yaml`
  contract. This prose file is only an operator-facing explanation; the YAML is the executable
  vocabulary."* It documents role/framework semantics, forbids inventing framework strings, and
  gives concrete signal examples (`@RestController` → `spring-mvc`/`rest-endpoint`, etc.).
- `mappings.md` → planning phase. Appended to the stack-advisor agent prompt
  (`commands/plan.ts:670`): `"Analyze all registered artifacts and propose a legacy→target framework
  mapping table.\n\n" + readStackInstruction(pack, "mappings")`. For java-spring this encodes e.g.
  JAX-RS → Spring MVC controllers, EJB → Spring services, JUnit 4 → JUnit 5, and modernization
  idioms (`SimpleDateFormat` → `java.time`).
- `test-convention.md` → migrate phase. Appended to test-writing prompts
  (`commands/migrate.ts:223-224`). java-spring's is one paragraph: JUnit 5, prefer plain unit tests
  over full-context tests.

Because prompts are assembled from pack data, swapping stacks swaps agent behavior without touching
core code.

### 3.4 `audit.rules.yaml` — source-scan audit rules

Loaded eagerly as part of `loadStackPack` (the `rules` field of `LoadedStackPack`). Each rule
(`StackAuditRule`, stack.ts:9-22) has a `finding` kind (`jvm` | `dependency` | `python-compat`),
severity, a `match` regex applied line-by-line (`collectLineMatches`, audit.ts:41-55), and templates
interpolated with the `{symbol}/{line}/{text}/{version}` vocabulary.

Consumed by `refreshCompatibilityAudits()` (`migration/guildctl/audit.ts:93-128`) during **plan
readiness**: for every registered `legacy-source` artifact it runs all rules over the file content,
writes `jvm_audit_findings` / `dependency_findings` rows (replace semantics), mines dependency
versions from `manifest_globs` via `dependency_parsers` so `coordinate_hints` can pin current
versions into summaries, then runs the external probes and stores a `pre_plan_audit` summary in
operator state. Examples of real rules:

```yaml
# stacks/java-spring/audit.rules.yaml
- id: jvm-internal-api
  finding: jvm
  severity: critical
  match: '\b(?:sun|com\.sun|jdk\.internal)\.[A-Za-z0-9_$.]+'
  summary_template: 'Internal JDK API usage detected: {symbol}'
# stacks/python/audit.rules.yaml
- id: python2-print-statement
  finding: python-compat
  match: '^\s*print\s+(?!\().+'
```

External probes (`runExternalProbes`, stack.ts:335-342) are best-effort: availability is probed
first (`jdeps --version`, `pip --version`, …); if unavailable the run still succeeds with the
`fallback_note`. Probe findings are informational context for planning; the deterministic regex scan
is the authoritative record.

### 3.5 `scaffold/` templates and the `scaffold:` block

Consumed almost entirely by `migration/guildctl/commands/bootstrap.ts`, which creates the
`modern/` target project:

- **Project type selection** (`project_types`, bootstrap.ts:29+): a description matches if `any`
  role/framework/path predicate holds (→ `web`), or `all_roles` hold (→ `library`), else the
  default `service`. Each type names its build template
  (`scaffold/build.gradle.web.template` vs `pyproject.web.toml.template`, etc.).
- **Rendering** (bootstrap.ts:147-174): templates are read from the pack dir and rendered by plain
  marker substitution — `group_marker`, `app_name_marker`, `package_marker`, `app_class_marker` —
  not by a general templating engine. Derived values fall back to `scaffold.default_package` /
  `default_app_name` when artifacts give no better signal
  (`deriveBootstrapBasePackage`, bootstrap.ts:83).
- **Layout** (`main_source_dir`, `test_source_dir`, `resources_dir`, `resources_file`,
  `build_file`, `settings_file`): used both to create the tree and, in
  `isAlreadyScaffolded()`-style checks (bootstrap.ts:131-137), to decide idempotency. The warden
  treats the same layout as shared scaffolding state (`migration/guildctl/warden.ts:204-209` lists
  `modern/${scaffold.build_file}` etc. as project-level outputs owned by bootstrap, not by any
  single artifact).

One subtle failure mode is pinned by a test: bare-marker substitution could corrupt Spring Boot API
symbols when a marker string collides with code text; `stack-pack-engine.test.ts:260` covers
*"bootstrap does not corrupt Spring Boot API symbols via bare-marker substring collision"* and
reserved-word package sanitization.

### 3.6 `verify.per_artifact` — data-declared compile checks

`resolvePerArtifactVerify()` (stack.ts:163-170) returns the block or `undefined`; a pack without
`verify:` is valid and simply means artifacts record `unverified`/`no-stack-check`. Consumers:

- `migration/guildctl/verify.ts:732` and `commands/auto.ts:481` resolve the check per artifact;
  note the defensive pattern in verify.ts — a malformed/unresolvable pack means *"a missing check is
  not a failed verification"*. Verification records truth; it never gates advancement ("Verification
  is a record, never a gate").
- Argument expansion (`expandVerifyArgs`, stack.ts:140-142) substitutes placeholders into discrete
  argv entries and the caller spawns with `shell: false`, so metacharacters in paths cannot alter
  the command. Tested at `stack-pack-engine.test.ts:199`.

## 4. End-to-end flow across the pipeline

1. **init/detect**: `cli.ts:130` picks the stack via `--stack` or `detectStack()`; written to guild
   config.
2. **inventory** (Phase 1): scanner registers files matching `source_globs`, deriving artifact ids
   with `scaffold.source_extension`; classification batches get `JSON.stringify(spec)` +
   `classify.md`; results validated against `frameworks.allowed` / `roles.allowed` and quality
   gates before the phase can complete.
3. **audit refresh → plan** (Phase 2): `runPlan` calls `refreshCompatibilityAudits()` first
   (plan.ts:546-547) — audit rules produce findings that feed dependency disposition and planning —
   then the stack-advisor gets `mappings.md`.
4. **bootstrap/migrate** (Phase 3): `modern/` is scaffolded from `scaffold/` templates when the
   first target module needs it (`commands/migrate.ts:171` triggers bootstrap automatically);
   coding agents work inside the pack-defined layout; test agents receive `test-convention.md`;
   each migrated artifact optionally goes through `verify.per_artifact`.
5. **review/close-out**: the warden consults the scaffold block for ownership boundaries; review
   sees verification records (`verified` vs `unverified` vs `no-stack-check`) produced from the
   pack's verify declaration.

## 5. Why it works this way

- **Data over code** (Constitution VII): adding a stack must not require touching `guildctl`. All
  stack knowledge — including shell commands for verification and probing — is YAML/templates.
  This also keeps the security surface small: commands come from reviewed pack files, expanded
  through closed placeholder vocabularies, spawned without a shell.
- **Fail fast on vocabulary, degrade gracefully elsewhere**: unknown interpolation placeholders and
  bad classification specs throw at load; but a missing `verify:` block, an unavailable probe
  binary, or even a broken verify resolution merely downgrade fidelity (unverified notes, fallback
  notes) instead of blocking the pipeline. The design principle is: *structural errors fail loudly;
  environmental gaps are recorded honestly.*
- **Closed vocabularies everywhere**: allowed frameworks/roles, allowed placeholders (two distinct
  sets), allowed `dependencies:` keys. Agents are treated as untrusted input producers whose
  outputs are normalized/rejected against the pack's vocabulary.

## 6. Extension points and dead-ish fields

Two manifest blocks currently have **no runtime consumer** and say so in their own doc comment
(stack.ts:186-191):

- `logic_extraction:` (`service_suffix`, `validator_suffix`, `handler_roles`) — *"Data-only — no
  runtime consumer; mappings.md prose and audit.rules.yaml regexes are hand-authored to match these
  suffixes, not generated from them."*
- `view_contract:` — declared by java-spring (`format: openapi`, `drop_rule: presentational`) and
  referenced by name in `mappings.md` prose and enforced indirectly by hand-written
  `view-regeneration-*` rules in `audit.rules.yaml` (e.g. `view-regeneration-jsp`); grep finds no
  TypeScript consumer of the field itself. Treat these as authoring conventions that keep the prose
  and regexes coherent, not as machine-enforced switches.

## 7. Failure modes of a malformed pack

| Defect | Symptom | Where |
|---|---|---|
| Unknown `{placeholder}` in manifest/rules | throws at `loadStackPack` | stack.ts:214,157 |
| Unknown `{placeholder}` in `verify:` | throws at `loadStackPack` | stack.ts:157 |
| Missing `classification_spec` key | throws from `loadClassificationSpec`/`loadDispositionSpec` | classification.ts:103, dispositions.ts:45 |
| `fallback`/`ambiguous` not in `allowed`, bad signal refs | throws from `validateSpec` | classification.ts:111-122 |
| Unknown `dependencies.*` key | throws | dispositions.ts:54 |
| Agent invents a framework/role | batch rejected by `validateBatch`/`normalizeFramework` | classification.ts:212-229,124-132 |
| Misspelled manifest field (e.g. `source_glob`) | silently undefined → downstream empty scans / opaque errors; **no schema validation exists** | — |
| No pack matches `legacy/` (or several do) | init refuses; demands `--stack <id>` | stack.ts:324-326 |

The last-but-one row is the sharpest edge: the loader casts YAML to `StackManifest` without
validation, so typos fail far from their cause. When authoring, rely on copying a shipped pack and
on `migration/test/stack-pack-engine.test.ts`.

## 8. Authoring a new stack pack, step by step

1. Create `stacks/<id>/` and mirror it to `package/stacks/<id>/` (byte-identical — CI enforces it,
   `stack-pack-engine.test.ts:146`).
2. Write `stack.yaml`: unique `id`; `detect.markers` that match your legacy tree and don't overlap
   other packs'; `source_globs`/`manifest_globs` for your languages; `dependency_parsers` whose
   regexes have exactly three groups (`group:artifact:version`); the three `instructions:` paths;
   a full `scaffold:` block (markers must appear in your templates); optional `verify.per_artifact`
   using only `{artifact_path|output_paths|dependency_paths|scope_paths|module|workspace_root}`,
   with `availability_args` so absence of the toolchain degrades gracefully.
3. Write `classification.yaml`: non-empty `frameworks.allowed` containing your `fallback` and
   `ambiguous` entries; `roles.allowed` drawn from registry roles; `signals` with path/content
   regexes for each framework you care about; `modules.source_roots` to derive build-module names;
   `quality.*` thresholds. Optionally add the `dependencies:` disposition block.
4. Write the three Markdown files. Remember: `classification.yaml` is executable, `classify.md` is
   explanatory; keep `mappings.md` aligned with any hand-written audit rules (there is no generator).
5. Write `audit.rules.yaml` with `finding: <jvm|python-compat|dependency>` rules; use only
   `{symbol,line,text,version}` in templates. Add external probes if useful tools exist.
6. Add `scaffold/` templates containing your declared markers.
7. Smoke-test: `guildctl init --stack <id>` on a fixture workspace, then run inventory and plan and
   watch for load-time throws (§7). Model new tests on `stack-pack-engine.test.ts`, which drives the
   whole Java and Python packs end-to-end *"as pure data"* (tests at lines 17 and 94).

Relevant tests: `migration/test/stack-pack-engine.test.ts` (loading, placeholders, verify argv,
byte-identical packaging, bootstrap rendering), `migration/test/classification-batching.test.ts` and
`inventory-classification.test.ts` (spec validation/batch application),
`migration/test/disposition-pack-yaml.test.ts` and `disposition-collector.test.ts`
(`dependencies:` block), `migration/test/audit-view-regeneration.test.ts` (view-regeneration audit
rules), `migration/test/verify-stack-default.test.ts` (per-artifact verify wiring).
