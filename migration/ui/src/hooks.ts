/**
 * React hooks for fetching registry data.
 *
 * All data-fetching logic lives here so components stay pure and testable.
 * Each hook manages its own loading/error state and exposes a `reload` callback
 * so any component can trigger a manual refresh.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
} from "react";
import {
  fetchArtifacts,
  fetchBlockers,
  fetchEvents,
  fetchIssues,
  fetchApprovalHistory,
  fetchPendingApprovals,
  fetchRunStatus,
  getSociety,
  fetchRunLog,
  fetchRuns,
  fetchSessions,
  fetchStatus,
  fetchWavePlan,
} from "./api";
import type { ArtifactQuery } from "./api";
import type {
  ApprovalDecision,
  Artifact,
  ArtifactEvent,
  BlockerListResult,
  BlockerQuery,
  BlockerEntry,
  IssueListResult,
  IssueQuery,
  IssueEntry,
  PendingApproval,
  RunEntry,
  RunFilters,
  RunListResult,
  RunQuery,
  RunStatusEntry,
  SessionFilters,
  SessionListResult,
  SessionQuery,
  SessionEntry,
  StatusResponse,
  SocietyResponse,
  WavePlanEntry,
} from "./types";

interface LoadableState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}



// Basic deep equality check for JSON-like API responses
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);
  if (isArrayA !== isArrayB) return false;

  if (isArrayA && isArrayB) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }

  return false;
}

function useLoadableData<T>(
  loader: () => Promise<T>,
  initialData: T,
  deps: DependencyList,
  pollIntervalMs?: number,
): LoadableState<T> {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);
  // Only the very first load for this hook instance should flip `loading`
  // (which callers use to unmount their whole view, e.g. ApprovalsPanel).
  // Subsequent loads — most notably a poll-interval refetch — must update
  // `data`/`error` silently so an in-progress form isn't unmounted every
  // pollIntervalMs.
  const hasLoadedOnceRef = useRef(false);

  const load = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    setError(null);
    loader()
      .then((result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        // ⚡ Bolt: Deep compare polling results to prevent unnecessary state updates
        // and cascading re-renders in memoized child components
        setData((prev) => isEqual(prev, result) ? prev : result);
        setLoading(false);
        hasLoadedOnceRef.current = true;
      })
      .catch((e: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
        hasLoadedOnceRef.current = true;
      });
  }, deps);

  useEffect(() => {
    load();
    if (!pollIntervalMs) return;
    const timer = window.setInterval(load, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [load, pollIntervalMs]);

  // ⚡ Bolt: Memoize the hook result so object references remain stable
  // when the parent component re-renders for other reasons
  return useMemo(
    () => ({ data, loading, error, reload: load }),
    [data, loading, error, load]
  );
}

// ── useArtifacts ──────────────────────────────────────────────────────────────

export interface UseArtifactsResult {
  artifacts: Artifact[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Fetches the artifact list, re-fetching whenever `query` changes.
 * Query identity is compared by value (JSON-serialised) to avoid unnecessary
 * re-renders when a parent passes a new object literal on every render.
 */
export function useArtifacts(query: ArtifactQuery = {}): UseArtifactsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchArtifacts(JSON.parse(queryKey) as ArtifactQuery),
    [] as Artifact[],
    [queryKey],
  );

  return {
    artifacts: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── useStatus ─────────────────────────────────────────────────────────────────

export interface UseStatusResult {
  status: StatusResponse | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Fetches the registry status summary (file counts + operator state). */
export function useStatus(): UseStatusResult {
  const state = useLoadableData(
    () => fetchStatus(),
    null as StatusResponse | null,
    [],
  );

  return {
    status: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── useEvents ─────────────────────────────────────────────────────────────────

export interface UseEventsResult {
  events: ArtifactEvent[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Fetches the event log for a single artifact, refetching when id changes. */
export function useEvents(artifactId: string): UseEventsResult {
  const state = useLoadableData(
    () => fetchEvents({ id: artifactId }),
    [] as ArtifactEvent[],
    [artifactId],
    5_000,
  );

  return {
    events: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseSocietyResult {
  society: SocietyResponse | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Polls the society aggregate, optionally including one artifact's proof rows. */
export function useSociety(artifactId?: string): UseSocietyResult {
  const state = useLoadableData(
    () => getSociety({ id: artifactId }),
    null as SocietyResponse | null,
    [artifactId],
    5_000,
  );
  return { society: state.data, loading: state.loading, error: state.error, reload: state.reload };
}

// ── Feature hooks ─────────────────────────────────────────────────────────────

export interface UseWavePlanResult {
  wavePlan: WavePlanEntry[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useWavePlan(): UseWavePlanResult {
  const state = useLoadableData(
    () => fetchWavePlan(),
    [] as WavePlanEntry[],
    [],
  );

  return {
    wavePlan: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseSessionsResult {
  sessions: SessionEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: SessionFilters;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useSessions(query: SessionQuery = {}): UseSessionsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchSessions(JSON.parse(queryKey) as SessionQuery),
    {
      items: [] as SessionEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies SessionListResult,
    [queryKey],
  );

  return {
    sessions: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseBlockersResult {
  blockers: BlockerEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useBlockers(query: BlockerQuery = {}): UseBlockersResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchBlockers(JSON.parse(queryKey) as BlockerQuery),
    {
      items: [] as BlockerEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies BlockerListResult,
    [queryKey],
  );

  return {
    blockers: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseIssuesResult {
  issues: IssueEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: IssueListResult["available_filters"];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useIssues(query: IssueQuery = {}): UseIssuesResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchIssues(JSON.parse(queryKey) as IssueQuery),
    {
      items: [] as IssueEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies IssueListResult,
    [queryKey],
  );

  return {
    issues: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseRunsResult {
  runs: RunEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: RunFilters;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useRuns(query: RunQuery = {}): UseRunsResult {
  const queryKey = JSON.stringify(query);
  const state = useLoadableData(
    () => fetchRuns(JSON.parse(queryKey) as RunQuery),
    {
      items: [] as RunEntry[],
      total: null,
      page: 1,
      page_size: query.page_size ?? 25,
      total_pages: null,
    } satisfies RunListResult,
    [queryKey],
  );

  return {
    runs: state.data.items,
    total: state.data.total,
    page: state.data.page,
    pageSize: state.data.page_size,
    totalPages: state.data.total_pages,
    availableFilters: state.data.available_filters,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

export interface UseRunLogResult {
  log: string | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useRunLog(runId: string | null): UseRunLogResult {
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    if (!runId) {
      setLog(null);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    fetchRunLog(runId)
      .then((data) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setLog(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  return { log, loading, error, reload: load };
}

// ── useApprovals (US4, spec 013) ─────────────────────────────────────────────

export interface UseApprovalsResult {
  pending: PendingApproval[];
  history: ApprovalDecision[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Fetches the approval-gate queue plus the decided history. The pending list
 * polls (operator-facing queue, like events/society); history refreshes on
 * load and on `reload` (called after every submitted decision).
 */
export function useApprovals(): UseApprovalsResult {
  const pendingState = useLoadableData(
    () => fetchPendingApprovals(),
    [] as PendingApproval[],
    [],
    5_000,
  );
  const historyState = useLoadableData(
    () => fetchApprovalHistory(),
    [] as ApprovalDecision[],
    [],
  );

  const reload = useCallback(() => {
    pendingState.reload();
    historyState.reload();
  }, [pendingState.reload, historyState.reload]);

  return {
    pending: pendingState.data,
    history: historyState.data,
    loading: pendingState.loading || historyState.loading,
    error: pendingState.error ?? historyState.error,
    reload,
  };
}

// ── useRunStatus (spec 016, #220) ────────────────────────────────────────────

export interface UseRunStatusResult {
  runStatus: RunStatusEntry[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Fetches the four-state working/idle/waiting-for-approval/rejected label
 * per non-terminal artifact from GET /api/run-status, polling on the same
 * cadence as the other live dashboard panels (events/society/approvals) —
 * no new polling mechanism (FR-011).
 */
export function useRunStatus(): UseRunStatusResult {
  const state = useLoadableData(
    () => fetchRunStatus(),
    [] as RunStatusEntry[],
    [],
    5_000,
  );

  return {
    runStatus: state.data,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}

// ── useRegistryData ───────────────────────────────────────────────────────────

export interface UseRegistryDataResult {
  artifacts: UseArtifactsResult;
  status: UseStatusResult;
  wavePlan: UseWavePlanResult;
  sessions: UseSessionsResult;
  blockers: UseBlockersResult;
  issues: UseIssuesResult;
  runs: UseRunsResult;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export interface UseRegistryDataQueries {
  sessions?: SessionQuery;
  blockers?: BlockerQuery;
  issues?: IssueQuery;
  runs?: RunQuery;
}

/**
 * Combined hook for the main app shell — fetches baseline registry data and the
 * active monitoring slices, exposing a single `reload` callback that refreshes
 * all of them.
 */
export function useRegistryData(
  queries: UseRegistryDataQueries = {},
): UseRegistryDataResult {
  const artifacts = useArtifacts();
  const status = useStatus();
  const wavePlan = useWavePlan();
  const sessions = useSessions(queries.sessions);
  const blockers = useBlockers(queries.blockers);
  const issues = useIssues(queries.issues);
  const runs = useRuns(queries.runs);

  const reload = useCallback(() => {
    artifacts.reload();
    status.reload();
    wavePlan.reload();
    sessions.reload();
    blockers.reload();
    issues.reload();
    runs.reload();
  }, [
    artifacts.reload,
    status.reload,
    wavePlan.reload,
    sessions.reload,
    blockers.reload,
    issues.reload,
    runs.reload,
  ]);

  // ⚡ Bolt: Memoize the registry data object so referential equality is preserved
  // unless the underlying hooks actually return new references.
  return useMemo(
    () => ({
      artifacts,
      status,
      wavePlan,
      sessions,
      blockers,
      issues,
      runs,
      loading: artifacts.loading || status.loading,
      error: artifacts.error ?? status.error,
      reload,
    }),
    [
      artifacts,
      status,
      wavePlan,
      sessions,
      blockers,
      issues,
      runs,
      reload,
    ]
  );
}
