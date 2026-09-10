# Source Dependency Extraction and Pooling

## Purpose and Overview

The **Source Dependency Extraction and Pooling** subsystem (located in `migration/registry/commands/sourceDeps.ts`) is responsible for deterministically analyzing source code files to build a dependency graph of artifacts, and organizing them into parallel execution pools.

This subsystem provides the foundation for determining execution order during migration. By extracting dependencies statically at the source code level (using regular expressions rather than complex AST parsing), it handles uncompilable or partially broken legacy code gracefully. Once extracted, these dependencies are used to construct a Directed Acyclic Graph (DAG), resolving any circular dependencies, to ultimately yield a level-order execution plan (pools) where independent components can run in parallel, and dependent components only run after their dependencies complete.

## Architecture & Data Flow

The subsystem works in three distinct phases:

### 1. Regex-Based Extraction (`extractSourceDependencies`)

The `extractSourceDependencies` function analyzes the content of a single source file and identifies dependencies.

- **Inputs**: It takes the `dependentId` (the artifact being analyzed), the source code `content`, the `lang` (currently supporting `java` or `python`), a set of known artifact `ids`, and a map of `aliases`.
- **Mechanism**:
  - For **Java**, it looks for `import` statements (e.g., `import static com.example.MyClass;`) and inheritance keywords (`extends` and `implements`). It correctly handles simple single-type references while ignoring complex generic parameters.
  - For **Python**, it looks for `from ... import ...` and `import ...` statements.
- **Resolution**: Extracted references are resolved to their fully-qualified artifact IDs using `resolveQualifiedName`. If multiple matches exist and it's ambiguous, it conservatively returns `null`, preferring precision over guessing.
- **Why Regex?**: The explicit design choice is to use regex instead of an AST. As noted in the source: *"These functions are pure and deterministic so they can be unit-tested without an LLM. Extraction is regex-level... which is the agreed bar — the conservative direction is extra links, which only costs parallelism, never correctness."*

### 2. Collapsing Circular Dependencies (`collapseSCC`)

Legacy codebases frequently contain circular dependencies (e.g., Class A imports Class B, and Class B imports Class A). A naive longest-path walk over a cyclic graph would never terminate. To solve this, the subsystem uses **Tarjan's Strongly Connected Components (SCC) algorithm**.

- **Mechanism**: The `collapseSCC` function implements Tarjan's algorithm using a depth-first search (DFS) with a stack. It assigns an `index` and `low` link value to each node. When a cycle is detected, all members of that cycle are popped from the stack and grouped into a single component (an array of string IDs).
- **Outcome**: The cyclic graph is condensed into a Directed Acyclic Graph (DAG) where each node is a Strongly Connected Component.

### 3. Building Parallel Pools (`buildParallelPools`)

With the dependencies extracted and cycles collapsed, the subsystem schedules the execution order.

- **Mechanism**:
  - It fetches all `first-class` artifacts from the database and all extracted dependency edges.
  - It runs `collapseSCC` to condense the graph.
  - It calculates the topological level for each component using a longest-path layering approach (`visit` recursive function).
  - It emits pools level by level (0 to maxLevel).
- **Constraints Maintained**:
  - **Level Ordering**: A pool only starts after its predecessor levels have completed.
  - **Cycle Serialization**: Cycle members must run serially relative to each other. If an SCC contains multiple nodes (a cycle), each member is placed in its own singleton pool at that level.
  - **Parallelism Limit**: Independent singleton nodes at the same level are grouped into arrays of size up to the specified `parallel` limit.

## Database Integration

The extracted links are persisted to the SQLite registry via `recordAutoDependencies`.

- **Mechanism**: It uses a transaction to delete any existing `'auto'` generated links for the dependent ID, and then inserts the new links.
- **Preservation**: This specifically deletes `created_by = 'auto'` links, explicitly preserving manually added dependencies (`addManualDependency`), ensuring human overrides are not wiped out by subsequent auto-extraction passes.

## Invariants & Edge Cases

- **Ambiguous Resolutions**: If a simple class name (e.g., `User`) matches multiple fully qualified paths in the registry and the provided reference isn't fully qualified, `resolveQualifiedName` returns `null`. This prevents incorrect dependency links at the cost of potential missed links (which is acceptable as manual dependencies can be added).
- **Generics in Java**: The regex for `extends / implements` splits by `< > ,` to handle simple generics by grabbing the first type argument when it is a plain identifier.
- **Cyclic Graph Deadlocks**: Handled entirely by `collapseSCC`. The invariant is that the pool builder will never encounter an infinite loop, no matter how tangled the legacy imports are.

## Gotchas

- **No AST Parsing**: Because extraction relies on regex, commented-out code or string literals containing import statements might be incorrectly flagged as dependencies. This is considered acceptable because it only *adds* false-positive dependency links, which limits parallelism but does not break correctness.

## Extension Points

- **Language Support**: The `SourceLang` type and `extractSourceDependencies` can be easily extended to support other languages (like TypeScript or C#) by adding new regex patterns for their respective module import systems.
- **Alias Resolution**: The `aliases` map allows external systems (like stack packs or custom heuristics) to provide hints for resolving custom framework-specific naming conventions that standard Java/Python imports might miss.