# 0001 — Rebrand to Migration Guild

Status: Accepted  
Date: 2026-06-15

## Decision

Functionally rebrand the existing `legmod` kit into **Migration Guild**.

- Product/user-facing name: **Migration Guild**
- Public CLI command identity: **`guildctl`**
- Positioning: **evidence-first modernization** — a blackboard society for legacy software modernization
- Compatibility stance: **hard public cut** — do not preserve old `legmod` command aliases

Evidence-first modernization means Migration Guild accepts modernization work through executable proof, not model confidence, vibes, or self-approval. Writers may propose changes; reviewers/arbiter gates must require evidence before acceptance.

This is a product and command-surface rebrand first, not a deep internal transplant.

## Scope

Update the public and command-facing surface:

- README and public docs
- UI text and dashboard titles
- package names/descriptions where user-visible
- CLI help text and command identity
- examples and documented commands
- npm scripts/documented setup commands
- installer/public setup command identity
- public config filename where exposed

## Name mapping

- `Happy Little Bots` → **Migration Guild** when it appears in user-facing prose
- User-facing `legmod` → **Migration Guild**
- Typed CLI command `legmod` → **`guildctl`**
- `legmod-setup` → **`guildctl-setup`**
- `legmod.config.json` → **`guildctl.config.json`** where public/config-facing
- `@happylittlebot/*` package scope → **`@migration-guild/*`** where package identity is public
- `[legmod]` log prefix → **`[guildctl]`**

## Keep for now

Do **not** rename these during the functional rebrand unless a later explicit decision allows it:

- `LEGMOD_*` environment variables
- `legmod/` folder path
- `legmod/dist/cli.js`
- `legmod/cli.ts`
- `LegmodConfig` internal type/interface names
- `registry` CLI identity
- tsup/build entries that point at internal `legmod` paths

Reason: these are internal runner/agent/build contracts. Renaming them now risks silent pipeline breakage and is not required for the public rebrand.

## No legacy public aliases

Do not add or preserve a public `legmod` command alias.

The public command should be `guildctl`. Old public command references should be removed, not carried forward as compatibility surface.

Exception: old internal path segments may remain where they are implementation details, not public command aliases.

## Repo structure note

`package/tools/` and `migration/` are mirrored trees. Treat `package/` as canonical and keep `migration/` synchronized.

Implementation must verify twin sync with:

```bash
diff -rq migration package/tools | grep -v node_modules
```

Generated files should be regenerated, not hand-edited:

- `**/dist/**`
- `**/ui-dist/**`
- `package/setup.js`
- lockfiles

## Deferred decisions

The following are explicitly deferred:

- demo/migration-slice selection
- `LEGMOD_*` env var rename
- `legmod/` folder rename
- Azure DevOps project/repo rename
- deep internal module/import/type renames
- executable-evidence gate implementation

## Rationale

The project already contains the core Migration Guild organism: blackboard registry, role-separated agents, claim ownership, event log, and dashboard. The immediate need is to make the product identity coherent without cutting the internal nervous system.

Functional rebrand first. Deep transplant later only if it proves worth the risk.
