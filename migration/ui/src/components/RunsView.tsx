import { useState } from "react";
import { useRunLog } from "../hooks";
import type { RunEntry, RunFilters, RunQuery, TimeDisplayMode } from "../types";
import { formatDuration, formatTimestamp } from "../format";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";
import RunLogViewer from "./RunLogViewer";

export default function RunsView({
  runs,
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
  runs: RunEntry[];
  total: number | null;
  page: number;
  pageSize: number;
  totalPages: number | null;
  availableFilters?: RunFilters;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  query: RunQuery;
  onQueryChange: (updates: Partial<RunQuery>) => void;
  timeMode: TimeDisplayMode;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun =
    selectedRunId == null
      ? null
      : runs.find((run) => run.run_id === selectedRunId) ?? null;
  const {
    log,
    loading: logLoading,
    error: logError,
    reload: reloadLog,
  } = useRunLog(selectedRunId);

  const statuses =
    availableFilters?.statuses ?? Array.from(new Set(runs.map((run) => run.status))).sort();
  const agents =
    availableFilters?.agents ?? Array.from(new Set(runs.map((run) => run.agent))).sort();
  const models =
    availableFilters?.models ??
    Array.from(new Set(runs.map((run) => run.model).filter(Boolean) as string[])).sort();
  const statusFilter = query.status ?? "";
  const agentFilter = query.agent ?? "";
  const modelFilter = query.model ?? "";
  const sortBy = query.sort ?? "newest";
  const rangeStart = total && total > 0 ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd =
    total && total > 0 ? Math.min((page - 1) * pageSize + runs.length, total) : runs.length;
  const hasActiveFilters = Boolean(statusFilter || agentFilter || modelFilter);
  const canPageBackward = page > 1;
  const canPageForward = totalPages != null ? page < totalPages : runs.length === pageSize;

  if (loading) {
    return <LoadingState resource="runs" />;
  }

  if (error) {
    return <ErrorState resource="runs" error={error} onRetry={onRetry} />;
  }

  if (runs.length === 0 && !hasActiveFilters) {
    return (
      <EmptyState
        title="No runs recorded."
        detail="Completed and in-flight agent runs will appear here."
        actionLabel="Reload runs"
        onAction={onRetry}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="filters">
        <select
          aria-label="Run status filter"
          className="filter-select"
          value={statusFilter}
          onChange={(e) => onQueryChange({ status: e.target.value, page: 1 })}
        >
          <option value="">All statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          aria-label="Run agent filter"
          className="filter-select"
          value={agentFilter}
          onChange={(e) => onQueryChange({ agent: e.target.value, page: 1 })}
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
        <select
          aria-label="Run model filter"
          className="filter-select"
          value={modelFilter}
          onChange={(e) => onQueryChange({ model: e.target.value, page: 1 })}
        >
          <option value="">All models</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <select
          aria-label="Run sort"
          className="filter-select"
          value={sortBy}
          onChange={(e) => onQueryChange({ sort: e.target.value as RunQuery["sort"], page: 1 })}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="agent">Agent</option>
          <option value="duration">Duration</option>
        </select>
        <select
          aria-label="Run page size"
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
            ? `${runs.length} visible`
            : `${rangeStart}-${rangeEnd} of ${total} total`}
        </span>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="No runs match the current filters."
          actionLabel="Clear run filters"
          onAction={() => {
            onQueryChange({
              status: "",
              agent: "",
              model: "",
              sort: "newest",
              page: 1,
            });
          }}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Model</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.run_id}
                  className="clickable"
                  onClick={() =>
                    setSelectedRunId((current) =>
                      current === run.run_id ? null : run.run_id,
                    )
                  }
                >
                  <td className="mono">{run.run_id}</td>
                  <td>{run.agent}</td>
                  <td>{run.model ?? "-"}</td>
                  <td>
                    <span className={`badge ${run.status}`}>{run.status}</span>
                  </td>
                  <td>{formatTimestamp(run.started_at, timeMode)}</td>
                  <td>{formatTimestamp(run.finished_at, timeMode)}</td>
                  <td>{formatDuration(run.started_at, run.finished_at)}</td>
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

      <section>
        <h2 style={{ marginTop: 0 }}>Run log</h2>
        <RunLogViewer
          selectedRunId={selectedRunId}
          selectedRunLogFile={selectedRun?.log_file ?? null}
          log={log}
          loading={logLoading}
          error={logError}
          onRetry={reloadLog}
        />
      </section>
    </div>
  );
}
