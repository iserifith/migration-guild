/**
 * Root application shell for the Migration Guild registry inspector.
 *
 * ## Adding a new monitoring tab
 *
 * 1. Create your component under `src/components/`.
 * 2. Add an entry to the `TABS` array below (id, label, render).
 * 3. If your tab needs data not yet in TabProps, extend TabProps and
 *    useRegistryData / add a new hook in hooks.ts.
 * 4. Add any required API function in api.ts and types in types.ts.
 * 5. Remove the tab name from the "Planned" list in constants.ts.
 */

import React from "react";
import ArtifactList from "./components/ArtifactList";
import BlockersView from "./components/BlockersView";
import MissionControl from "./components/MissionControl";
import RunsView from "./components/RunsView";
import SessionsView from "./components/SessionsView";
import SocietyView from "./components/SocietyView";
import WavePlan from "./components/WavePlan";
import { useRegistryData, type UseRegistryDataResult } from "./hooks";
import type {
  BlockerQuery,
  IssueQuery,
  RunQuery,
  SessionQuery,
  TimeDisplayMode,
} from "./types";

// ── Tab definition ────────────────────────────────────────────────────────────

/** Props every tab's render function receives. */
export interface TabProps {
  artifacts: UseRegistryDataResult["artifacts"];
  status: UseRegistryDataResult["status"];
  wavePlan: UseRegistryDataResult["wavePlan"];
  sessions: UseRegistryDataResult["sessions"];
  blockers: UseRegistryDataResult["blockers"];
  issues: UseRegistryDataResult["issues"];
  runs: UseRegistryDataResult["runs"];
  timeMode: TimeDisplayMode;
  sessionQuery: SessionQuery;
  updateSessionQuery: (updates: Partial<SessionQuery>) => void;
  blockerQuery: BlockerQuery;
  updateBlockerQuery: (updates: Partial<BlockerQuery>) => void;
  issueQuery: IssueQuery;
  updateIssueQuery: (updates: Partial<IssueQuery>) => void;
  runQuery: RunQuery;
  updateRunQuery: (updates: Partial<RunQuery>) => void;
}

interface TabDef {
  /** Unique identifier; also shown as the nav label. */
  id: string;
  /** Human-readable nav label (may differ from id for spacing/capitalisation). */
  label: string;
  render: (props: TabProps) => React.ReactNode;
}

const TABS: TabDef[] = [
  {
    id: "Mission Control",
    label: "Mission Control",
    render: () => <MissionControl />,
  },
  {
    id: "Society",
    label: "Society",
    render: () => <SocietyView />,
  },
  {
    id: "Artifacts",
    label: "Artifacts",
    render: ({ artifacts, timeMode }) => (
      <ArtifactList
        artifacts={artifacts.artifacts}
        loading={artifacts.loading}
        error={artifacts.error}
        onRetry={artifacts.reload}
        timeMode={timeMode}
      />
    ),
  },
  {
    id: "Wave Plan",
    label: "Wave Plan",
    render: ({ wavePlan }) => (
      <WavePlan
        entries={wavePlan.wavePlan}
        loading={wavePlan.loading}
        error={wavePlan.error}
        onRetry={wavePlan.reload}
      />
    ),
  },
  {
    id: "Sessions",
    label: "Sessions",
    render: ({ sessions, sessionQuery, updateSessionQuery, timeMode }) => (
      <SessionsView
        sessions={sessions.sessions}
        total={sessions.total}
        page={sessions.page}
        pageSize={sessions.pageSize}
        totalPages={sessions.totalPages}
        availableFilters={sessions.availableFilters}
        loading={sessions.loading}
        error={sessions.error}
        onRetry={sessions.reload}
        query={sessionQuery}
        onQueryChange={updateSessionQuery}
        timeMode={timeMode}
      />
    ),
  },
  {
    id: "Blockers",
    label: "Blockers",
    render: ({
      blockers,
      issues,
      blockerQuery,
      updateBlockerQuery,
      issueQuery,
      updateIssueQuery,
      timeMode,
    }) => (
      <BlockersView
        blockers={blockers.blockers}
        blockersTotal={blockers.total}
        blockersPage={blockers.page}
        blockersPageSize={blockers.pageSize}
        blockersTotalPages={blockers.totalPages}
        blockersLoading={blockers.loading}
        blockersError={blockers.error}
        blockersOnRetry={blockers.reload}
        blockerQuery={blockerQuery}
        onBlockerQueryChange={updateBlockerQuery}
        issues={issues.issues}
        issuesTotal={issues.total}
        issuesPage={issues.page}
        issuesPageSize={issues.pageSize}
        issuesTotalPages={issues.totalPages}
        issueFilters={issues.availableFilters}
        issuesLoading={issues.loading}
        issuesError={issues.error}
        issuesOnRetry={issues.reload}
        issueQuery={issueQuery}
        onIssueQueryChange={updateIssueQuery}
        timeMode={timeMode}
      />
    ),
  },
  {
    id: "Runs",
    label: "Runs",
    render: ({ runs, runQuery, updateRunQuery, timeMode }) => (
      <RunsView
        runs={runs.runs}
        total={runs.total}
        page={runs.page}
        pageSize={runs.pageSize}
        totalPages={runs.totalPages}
        availableFilters={runs.availableFilters}
        loading={runs.loading}
        error={runs.error}
        onRetry={runs.reload}
        query={runQuery}
        onQueryChange={updateRunQuery}
        timeMode={timeMode}
      />
    ),
  },
];

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTabId, setActiveTabId] = React.useState<string>(TABS[0].id);
  const [timeMode, setTimeMode] = React.useState<TimeDisplayMode>("utc");
  const [sessionQuery, setSessionQuery] = React.useState<SessionQuery>({
    stalled: "all",
    sort: "age-desc",
    page: 1,
    page_size: 25,
  });
  const [blockerQuery, setBlockerQuery] = React.useState<BlockerQuery>({
    q: "",
    sort: "oldest",
    page: 1,
    page_size: 25,
  });
  const [issueQuery, setIssueQuery] = React.useState<IssueQuery>({
    severity: "",
    category: "",
    sort: "severity",
    page: 1,
    page_size: 25,
  });
  const [runQuery, setRunQuery] = React.useState<RunQuery>({
    status: "",
    agent: "",
    model: "",
    sort: "newest",
    page: 1,
    page_size: 25,
  });
  const {
    artifacts,
    status,
    wavePlan,
    sessions,
    blockers,
    issues,
    runs,
    reload,
  } = useRegistryData({
    sessions: sessionQuery,
    blockers: blockerQuery,
    issues: issueQuery,
    runs: runQuery,
  });
  const updateSessionQuery = React.useCallback(
    (updates: Partial<SessionQuery>) =>
      setSessionQuery((current) => ({ ...current, ...updates })),
    [],
  );
  const updateBlockerQuery = React.useCallback(
    (updates: Partial<BlockerQuery>) =>
      setBlockerQuery((current) => ({ ...current, ...updates })),
    [],
  );
  const updateIssueQuery = React.useCallback(
    (updates: Partial<IssueQuery>) =>
      setIssueQuery((current) => ({ ...current, ...updates })),
    [],
  );
  const updateRunQuery = React.useCallback(
    (updates: Partial<RunQuery>) =>
      setRunQuery((current) => ({ ...current, ...updates })),
    [],
  );

  const byStatus = status.status?.files.by_status ?? {};
  const currentTab = TABS.find((t) => t.id === activeTabId) ?? TABS[0];

  return (
    <div className="layout">
      <header className="header">
        <span className="brand-mark" aria-hidden="true">▲</span>
        <h1>Migration Guild</h1>
        <span className="sep">/</span>
        <span className="project">registry inspector</span>
        <div className="header-actions">
          <span className="live-status"><span className="pulse" />Live</span>
          <div className="stats">
            {status.loading ? (
              <span className="stat">Loading status...</span>
            ) : status.error ? (
              <button className="header-button" onClick={status.reload} type="button">
                Retry status
              </button>
            ) : (
              Object.entries(byStatus).map(([s, n]) => (
                <span key={s} className={`stat ${s}`}>
                  {n} {s}
                </span>
              ))
            )}
          </div>
          <label className="time-control">
            <span className="time-label">Time</span>
            <select
              aria-label="Time display mode"
              className="filter-select"
              value={timeMode}
              onChange={(event) => setTimeMode(event.target.value as TimeDisplayMode)}
            >
              <option value="utc">UTC</option>
              <option value="local">Local time</option>
            </select>
          </label>
          <button className="header-button" onClick={reload} type="button">
            ↻ refresh
          </button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`tab ${activeTabId === t.id ? "active" : ""}`}
            onClick={() => setActiveTabId(t.id)}
          >
            {t.label}
          </div>
        ))}
      </nav>

      <main className="main">
        {currentTab.render({
          artifacts,
          status,
          wavePlan,
          sessions,
          blockers,
          issues,
          runs,
          timeMode,
          sessionQuery,
          updateSessionQuery,
          blockerQuery,
          updateBlockerQuery,
          issueQuery,
          updateIssueQuery,
          runQuery,
          updateRunQuery,
        })}
      </main>
    </div>
  );
}
