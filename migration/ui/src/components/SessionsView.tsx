import type { SessionEntry, SessionFilters, SessionQuery, TimeDisplayMode } from "../types";
import { formatAgeMinutes, formatTimestamp } from "../format";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function SessionsView({
  sessions,
  total,
  page,
  pageSize,
  totalPages,
  availableFilters,
  loading,
  error,
  onRetry,
  query,
  onQueryChange,
  timeMode,
}: {
  sessions: SessionEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: SessionFilters;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  query: SessionQuery;
  onQueryChange: (updates: Partial<SessionQuery>) => void;
  timeMode: TimeDisplayMode;
}) {
  const stalledFilter = query.stalled ?? "all";
  const statusFilter = query.status ?? "";
  const sortBy = query.sort ?? "age-desc";
  const statusOptions =
    availableFilters?.statuses ??
    Array.from(new Set(sessions.map((session) => session.status))).sort();
  const rangeStart = total && total > 0 ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd =
    total && total > 0 ? Math.min((page - 1) * pageSize + sessions.length, total) : sessions.length;
  const hasActiveFilters = Boolean(statusFilter) || stalledFilter !== "all";
  const canPageBackward = page > 1;
  const canPageForward = totalPages != null ? page < totalPages : sessions.length === pageSize;

  if (loading) {
    return <LoadingState resource="sessions" />;
  }

  if (error) {
    return <ErrorState resource="sessions" error={error} onRetry={onRetry} />;
  }

  if (sessions.length === 0 && !hasActiveFilters) {
    return (
      <EmptyState
        title="No active sessions."
        detail="In-progress claims will appear here when operators or agents pick up work."
        actionLabel="Reload sessions"
        onAction={onRetry}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="filters">
        <select
          aria-label="Session stall filter"
          className="filter-select"
          value={stalledFilter}
          onChange={(e) => onQueryChange({ stalled: e.target.value as SessionQuery["stalled"], page: 1 })}
        >
          <option value="all">All sessions</option>
          <option value="stalled">Stalled only</option>
          <option value="active">Active only</option>
        </select>
        <select
          aria-label="Session status filter"
          className="filter-select"
          value={statusFilter}
          onChange={(e) => onQueryChange({ status: e.target.value as SessionQuery["status"], page: 1 })}
        >
          <option value="">All statuses</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          aria-label="Session sort"
          className="filter-select"
          value={sortBy}
          onChange={(e) => onQueryChange({ sort: e.target.value as SessionQuery["sort"], page: 1 })}
        >
          <option value="age-desc">Oldest first</option>
          <option value="age-asc">Newest first</option>
          <option value="artifact">Artifact ID</option>
        </select>
        <select
          aria-label="Session page size"
          className="filter-select"
          value={String(pageSize)}
          onChange={(e) => onQueryChange({ page_size: Number(e.target.value), page: 1 })}
        >
          {[10, 25, 50].map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
        <span className="filter-meta">
          {total == null
            ? `${sessions.length} visible`
            : `${rangeStart}-${rangeEnd} of ${total} total`}
        </span>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          title="No sessions match the current filters."
          actionLabel="Clear session filters"
          onAction={() => {
            onQueryChange({
              stalled: "all",
              status: "",
              sort: "age-desc",
              page: 1,
            });
          }}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Claimed at</th>
                <th>Age</th>
                <th>Stalled</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <div className="cell-stack">
                      <span className="cell-primary mono">{session.id}</span>
                      <span className="cell-secondary mono">{session.path}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${session.status}`}>{session.status}</span>
                  </td>
                  <td>{session.claimed_by ?? "-"}</td>
                  <td>{formatTimestamp(session.claimed_at, timeMode)}</td>
                  <td>{formatAgeMinutes(session.claimed_minutes_ago)}</td>
                  <td>
                    <span className={`badge ${session.stalled ? "failed" : "completed"}`}>
                      {session.stalled ? "stalled" : "healthy"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total != null && (
        <div className="filters" style={{ marginBottom: 0 }}>
          <button
            className="state-button"
            disabled={!canPageBackward}
            onClick={() => onQueryChange({ page: page - 1 })}
            type="button"
          >
            Previous
          </button>
          <button
            className="state-button"
            disabled={!canPageForward}
            onClick={() => onQueryChange({ page: page + 1 })}
            type="button"
          >
            Next
          </button>
          <span className="filter-meta">
            Page {page}
            {totalPages != null ? ` of ${totalPages}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
