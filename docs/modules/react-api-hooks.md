# React API Hooks & Data Fetching

## Purpose and Overview

The Migration Guild frontend (`migration/ui/`) is a React application that provides live observability into the state of the migration pipeline. As autonomous agents continuously claim artifacts, generate code, and record evidence into the local SQLite registry, the React frontend must remain in sync to display active sessions, wave progress, and event logs.

The file `migration/ui/src/hooks.ts` contains all the React hooks responsible for data fetching. By encapsulating API calls, polling lifecycles, and state management within these hooks, the React components themselves remain pure, testable, and focused strictly on presentation.

This document details the architectural patterns, referential stability mechanisms, and polling lifecycle implemented within these data-fetching hooks.

## Architecture: The `useLoadableData` Engine

At the core of the UI's data fetching strategy is the internal `useLoadableData` hook. It abstracts the boilerplate of asynchronous data fetching, error handling, and component-level polling into a single, reusable engine.

### State Management and `hasLoadedOnceRef`

`useLoadableData` maintains `data`, `loading`, and `error` states using standard `useState`. However, it introduces a subtle optimization for polling via the `hasLoadedOnceRef`:

```typescript
const hasLoadedOnceRef = useRef(false);

const load = useCallback(() => {
  // ...
  if (!hasLoadedOnceRef.current) {
    setLoading(true);
  }
  // ...
});
```

The `loading` state is only ever flipped to `true` on the *very first* fetch for that hook instance. Subsequent background fetches triggered by the polling interval update the `data` and `error` states silently. This prevents the UI from constantly unmounting and remounting in-progress forms or view panels every time a background poll fires.

### Request Racing Prevention (`requestIdRef`)

Because network latency is unpredictable, a later API request might resolve before an earlier one, leading to race conditions where stale data overwrites fresh data. `useLoadableData` prevents this using a `requestIdRef`:

```typescript
const requestId = requestIdRef.current + 1;
requestIdRef.current = requestId;

loader().then((result) => {
  if (requestIdRef.current !== requestId) {
    return; // A newer request has already been dispatched, ignore this response.
  }
  // ... update state
});
```

Every time `load` is called, the request ID increments. When the promise resolves, it checks if its captured `requestId` still matches the current `requestIdRef`. If it doesn't, the response is discarded.

### Deep Equality and Polling Optimization (`isEqual`)

Polling a local backend is cheap, but unnecessarily re-rendering the entire React DOM every 2 seconds is expensive. If the server returns data that is structurally identical to the previous fetch (e.g., the event log hasn't changed), updating state with the newly allocated JSON object would normally trigger a cascading re-render in all memoized child components.

To prevent this, `useLoadableData` performs a custom deep equality check (`isEqual`) before applying the new state:

```typescript
setData((prev) => isEqual(prev, result) ? prev : result);
```

If the structural data hasn't changed, it strictly returns the `prev` reference, completely bypassing the React re-render cycle. (Note: `JSON.stringify` is deliberately *not* used here, as it is a React anti-pattern due to its sensitivity to object key order and performance overhead on large, deeply nested API responses.)

### Referential Stability (`useMemo`)

Even if `setData` bypasses updates when data is unchanged, the object returned by the `useLoadableData` hook itself must remain referentially stable across arbitrary re-renders of the parent component. Therefore, the hook wraps its return value in a `useMemo` block:

```typescript
return useMemo(
  () => ({
    data,
    loading,
    error,
    reload: load,
  }),
  [data, loading, error, load],
);
```

## Feature Hooks and Dependency Tracking

Specific data slices are exposed via dedicated feature hooks (e.g., `useArtifacts`, `useEvents`, `useSessions`) that wrap `useLoadableData`.

### Query Parameter Dependency Tracking (`useStableValue`)

Some feature hooks accept dynamic query parameters (like `useSessions(query: SessionQuery)`). Because these query objects are often passed inline by parent components (e.g., `<Component query={{ page: 1 }} />`), their object references change on every render.

To track these queries safely without triggering infinite fetch loops, the feature hooks stabilize the query object by reference via the `useStableValue` helper (see `useArtifacts` for the canonical example). It keeps the *previous* object reference whenever the new value is deep-equal (`isEqual`) to the stored one, so the dependency array only changes when the query actually changes:

```typescript
export function useArtifacts(query: ArtifactQuery = {}): UseArtifactsResult {
  const stableQuery = useStableValue(query); // Deep-equal stabilized reference
  const state = useLoadableData(
    () => fetchArtifacts(stableQuery),
    // ...
    [stableQuery],
  );
  // ...
}
```

This ensures the hook only refetches when the *values* within the query object change, independent of object reference churn — without the serialize/parse round-trip.

*(Previously this used a `JSON.stringify`-based query key; it was replaced by the deep-equality `useStableValue` ref pattern, which avoids key-order sensitivity and the `JSON.parse` round-trip overhead.)*

### Feature Hook Stability

Just as `useLoadableData` memoizes its return value, the higher-level feature hooks must also return stable object references. If a feature hook returns an object literal without wrapping it in `useMemo`, it breaks the chain of referential stability established lower down, causing cascading re-renders in dependent components. Every feature hook that derives its return object from `useLoadableData` state (e.g., `useArtifacts`, `useSessions`, `useBlockers`, `useIssues`, `useRuns`) wraps its return value in `useMemo` with granular dependencies on the returned slices.

For example, `useRegistryData` aggregates multiple individual feature hooks. It must wrap its massive return object in a `useMemo` block to preserve referential equality unless the underlying hooks actually change:

```typescript
return useMemo(
  () => ({
    artifacts,
    status,
    wavePlan,
    sessions,
    // ...
  }),
  [artifacts, status, wavePlan, sessions, /* ... */ reload]
);
```

*(If you ever add a new feature hook that returns an object, ensure the return statement is wrapped in `useMemo` if it derives state from `useLoadableData` or multiple `useState`s).*

## Extension Points

To add a new data hook:
1. Define the fetch wrapper in `migration/ui/src/api.ts`.
2. Add a new `useX` hook in `migration/ui/src/hooks.ts`.
3. If it takes dynamic query parameters, stringify them for the dependency array.
4. If it requires live background updates, pass a `pollIntervalMs` argument to `useLoadableData` (e.g., `5_000` for 5 seconds).
5. Ensure the hook returns a stable object, either by directly returning the `useLoadableData` result or wrapping a custom object literal in `useMemo`.
