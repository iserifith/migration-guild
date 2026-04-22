import type {
  BlockerEntry,
  BlockerQuery,
  IssueEntry,
  IssueFilters,
  IssueQuery,
  TimeDisplayMode,
} from "../types";
import { formatTimestamp } from "../format";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

export default function BlockersView({
  blockers,
  blockersTotal,
  blockersPage,
  blockersPageSize,
  blockersTotalPages,
  blockersLoading,
  blockersError,
  blockersOnRetry,
  blockerQuery,
  onBlockerQueryChange,
  issues,
  issuesTotal,
  issuesPage,
  issuesPageSize,
  issuesTotalPages,
  issueFilters,
  issuesLoading,
  issuesError,
  issuesOnRetry,
  issueQuery,
  onIssueQueryChange,
  timeMode,
}: {
  blockers: BlockerEntry[];
  blockersTotal: number | null;
  blockersPage: number;
  blockersPageSize: number;
  blockersTotalPages: number | null;
  blockersLoading: boolean;
  blockersError: Error | null;
  blockersOnRetry: () => void;
  blockerQuery: BlockerQuery;
  onBlockerQueryChange: (updates: Partial<BlockerQuery>) => void;
  issues: IssueEntry[];
  issuesTotal: number | null;
  issuesPage: number;
  issuesPageSize: number;
  issuesTotalPages: number | null;
  issueFilters?: IssueFilters;
  issuesLoading: boolean;
  issuesError: Error | null;
  issuesOnRetry: () => void;
  issueQuery: IssueQuery;
  onIssueQueryChange: (updates: Partial<IssueQuery>) => void;
  timeMode: TimeDisplayMode;
}) {
  const blockerSearch = blockerQuery.q ?? "";
  const blockerSort = blockerQuery.sort ?? "oldest";
  const issueSeverity = issueQuery.severity ?? "";
  const issueCategory = issueQuery.category ?? "";
  const issueSort = issueQuery.sort ?? "severity";
  const severityOptions =
    issueFilters?.severities ??
    Array.from(new Set(issues.map((issue) => issue.severity).filter(Boolean) as string[])).sort();
  const categoryOptions =
    issueFilters?.categories ??
    Array.from(new Set(issues.map((issue) => issue.category).filter(Boolean) as string[])).sort();
  const blockerRangeStart =
    blockersTotal && blockersTotal > 0 ? (blockersPage - 1) * blockersPageSize + 1 : 0;
  const blockerRangeEnd =
    blockersTotal && blockersTotal > 0
      ? Math.min((blockersPage - 1) * blockersPageSize + blockers.length, blockersTotal)
      : blockers.length;
  const issueRangeStart =
    issuesTotal && issuesTotal > 0 ? (issuesPage - 1) * issuesPageSize + 1 : 0;
  const issueRangeEnd =
    issuesTotal && issuesTotal > 0
      ? Math.min((issuesPage - 1) * issuesPageSize + issues.length, issuesTotal)
      : issues.length;

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <section>
        <h2 style={{ marginTop: 0 }}>Open blockers</h2>
        {blockersLoading ? (
          <LoadingState compact resource="blockers" />
        ) : blockersError ? (
          <ErrorState
            compact
            resource="blockers"
            error={blockersError}
            onRetry={blockersOnRetry}
          />
        ) : blockers.length === 0 ? (
          <EmptyState
            compact
            title="No open blockers."
            actionLabel="Reload blockers"
            onAction={blockersOnRetry}
          />
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="filters">
              <input
                aria-label="Blocker search"
                className="filter-input"
                onChange={(e) => onBlockerQueryChange({ q: e.target.value, page: 1 })}
                placeholder="Search artifact or summary"
                type="search"
                value={blockerSearch}
              />
              <select
                aria-label="Blocker sort"
                className="filter-select"
                value={blockerSort}
                onChange={(e) =>
                  onBlockerQueryChange({
                    sort: e.target.value as BlockerQuery["sort"],
                    page: 1,
                  })
                }
              >
                <option value="oldest">Oldest first</option>
                <option value="newest">Newest first</option>
                <option value="artifact">Artifact ID</option>
              </select>
              <select
                aria-label="Blocker page size"
                className="filter-select"
                value={String(blockersPageSize)}
                onChange={(e) =>
                  onBlockerQueryChange({ page_size: Number(e.target.value), page: 1 })
                }
              >
                {[10, 25, 50].map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
              <span className="filter-meta">
                {blockersTotal == null
                  ? `${blockers.length} visible`
                  : `${blockerRangeStart}-${blockerRangeEnd} of ${blockersTotal} total`}
              </span>
            </div>

            {blockers.length === 0 ? (
              <EmptyState
                compact
                title="No blockers match the current filters."
                actionLabel="Clear blocker filters"
                onAction={() => {
                  onBlockerQueryChange({ q: "", sort: "oldest", page: 1 });
                }}
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Artifact</th>
                      <th>Blocker</th>
                      <th>Summary</th>
                      <th>Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blockers.map((blocker) => (
                      <tr key={`${blocker.artifact_id}:${blocker.blocker_id ?? "open"}`}>
                        <td className="mono">{blocker.artifact_id}</td>
                        <td>{blocker.blocker_id ?? "-"}</td>
                        <td>
                          <span className="wrap-text" title={blocker.summary}>
                            {blocker.summary}
                          </span>
                        </td>
                        <td>{formatTimestamp(blocker.since, timeMode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {blockersTotal != null && (
              <div className="filters" style={{ marginBottom: 0 }}>
                <button
                  className="state-button"
                  disabled={blockersPage <= 1}
                  onClick={() => onBlockerQueryChange({ page: blockersPage - 1 })}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="state-button"
                  disabled={blockersTotalPages != null ? blockersPage >= blockersTotalPages : blockers.length < blockersPageSize}
                  onClick={() => onBlockerQueryChange({ page: blockersPage + 1 })}
                  type="button"
                >
                  Next
                </button>
                <span className="filter-meta">
                  Page {blockersPage}
                  {blockersTotalPages != null ? ` of ${blockersTotalPages}` : ""}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 style={{ marginTop: 0 }}>Open issues</h2>
        {issuesLoading ? (
          <LoadingState compact resource="issues" />
        ) : issuesError ? (
          <ErrorState
            compact
            resource="issues"
            error={issuesError}
            onRetry={issuesOnRetry}
          />
        ) : issues.length === 0 ? (
          <EmptyState
            compact
            title="No open issues."
            actionLabel="Reload issues"
            onAction={issuesOnRetry}
          />
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            <div className="filters">
              <select
                aria-label="Issue severity filter"
                className="filter-select"
                value={issueSeverity}
                onChange={(e) =>
                  onIssueQueryChange({ severity: e.target.value, page: 1 })
                }
              >
                <option value="">All severities</option>
                {severityOptions.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
              <select
                aria-label="Issue category filter"
                className="filter-select"
                value={issueCategory}
                onChange={(e) =>
                  onIssueQueryChange({ category: e.target.value, page: 1 })
                }
              >
                <option value="">All categories</option>
                {categoryOptions.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select
                aria-label="Issue sort"
                className="filter-select"
                value={issueSort}
                onChange={(e) =>
                  onIssueQueryChange({
                    sort: e.target.value as IssueQuery["sort"],
                    page: 1,
                  })
                }
              >
                <option value="severity">Severity</option>
                <option value="latest">Latest first</option>
                <option value="artifact">Artifact ID</option>
              </select>
              <select
                aria-label="Issue page size"
                className="filter-select"
                value={String(issuesPageSize)}
                onChange={(e) =>
                  onIssueQueryChange({ page_size: Number(e.target.value), page: 1 })
                }
              >
                {[10, 25, 50].map((size) => (
                  <option key={size} value={size}>
                    {size} / page
                  </option>
                ))}
              </select>
              <span className="filter-meta">
                {issuesTotal == null
                  ? `${issues.length} visible`
                  : `${issueRangeStart}-${issueRangeEnd} of ${issuesTotal} total`}
              </span>
            </div>

            {issues.length === 0 ? (
              <EmptyState
                compact
                title="No issues match the current filters."
                actionLabel="Clear issue filters"
                onAction={() => {
                  onIssueQueryChange({
                    severity: "",
                    category: "",
                    sort: "severity",
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
                      <th>Issue</th>
                      <th>Severity</th>
                      <th>Category</th>
                      <th>Summary</th>
                      <th>Logged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((issue) => (
                      <tr key={`${issue.artifact_id}:${issue.issue_id ?? issue.ts}`}>
                        <td className="mono">{issue.artifact_id}</td>
                        <td>{issue.issue_id ?? "-"}</td>
                        <td>
                          <span className={`badge severity-${issue.severity ?? "unknown"}`}>
                            {issue.severity ?? "-"}
                          </span>
                        </td>
                        <td>{issue.category ?? "-"}</td>
                        <td>
                          <span className="wrap-text" title={issue.summary}>
                            {issue.summary}
                          </span>
                        </td>
                        <td>{formatTimestamp(issue.ts, timeMode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {issuesTotal != null && (
              <div className="filters" style={{ marginBottom: 0 }}>
                <button
                  className="state-button"
                  disabled={issuesPage <= 1}
                  onClick={() => onIssueQueryChange({ page: issuesPage - 1 })}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="state-button"
                  disabled={issuesTotalPages != null ? issuesPage >= issuesTotalPages : issues.length < issuesPageSize}
                  onClick={() => onIssueQueryChange({ page: issuesPage + 1 })}
                  type="button"
                >
                  Next
                </button>
                <span className="filter-meta">
                  Page {issuesPage}
                  {issuesTotalPages != null ? ` of ${issuesTotalPages}` : ""}
                </span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
