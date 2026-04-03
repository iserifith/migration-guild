/**
 * Root application shell for the legmod registry inspector.
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
import WavePlan from "./components/WavePlan";
import { useRegistryData } from "./hooks";
import type { Artifact, StatusResponse } from "./types";

// ── Tab definition ────────────────────────────────────────────────────────────

/** Props every tab's render function receives. */
export interface TabProps {
  artifacts: Artifact[];
  status: StatusResponse | null;
}

interface TabDef {
  /** Unique identifier; also shown as the nav label. */
  id: string;
  /** Human-readable nav label (may differ from id for spacing/capitalisation). */
  label: string;
  render: (props: TabProps) => React.ReactNode;
}

/**
 * Tab registry — the single place to add monitoring views.
 *
 * Slice authors: append a new TabDef here when implementing a monitoring slice.
 * See constants.ts for the full list of planned tabs.
 */
const TABS: TabDef[] = [
  {
    id: "Artifacts",
    label: "Artifacts",
    render: ({ artifacts }) => <ArtifactList artifacts={artifacts} />,
  },
  {
    id: "Wave Plan",
    label: "Wave Plan",
    render: ({ artifacts }) => <WavePlan artifacts={artifacts} />,
  },
  // ↓ Future monitoring slices — uncomment / add entries below:
  // { id: "Sessions",     label: "Sessions",     render: (p) => <SessionsView     {...p} /> },
  // { id: "Blockers",     label: "Blockers",     render: (p) => <BlockersView     {...p} /> },
  // { id: "Runs",         label: "Runs",         render: (p) => <RunsView         {...p} /> },
  // { id: "Quality",      label: "Quality",      render: (p) => <QualityView      {...p} /> },
  // { id: "Cost",         label: "Cost",         render: (p) => <CostView         {...p} /> },
  // { id: "Claimability", label: "Claimability", render: (p) => <ClaimabilityView {...p} /> },
  // { id: "Batch Jobs",   label: "Batch Jobs",   render: (p) => <BatchJobsView    {...p} /> },
  // { id: "Dependencies", label: "Dependencies", render: (p) => <DependenciesView {...p} /> },
];

// ── App shell ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTabId, setActiveTabId] = React.useState<string>(TABS[0].id);
  const { artifacts, status, loading, error, reload } = useRegistryData();

  const byStatus = status?.files.by_status ?? {};
  const currentTab = TABS.find((t) => t.id === activeTabId) ?? TABS[0];

  return (
    <div className="layout">
      <header className="header">
        <h1>legmod</h1>
        <span className="sep">›</span>
        <span className="project">registry inspector</span>
        <div className="stats">
          {Object.entries(byStatus).map(([s, n]) => (
            <span key={s} className={`stat ${s}`}>{n} {s}</span>
          ))}
        </div>
        <button
          onClick={reload}
          style={{
            marginLeft: 8,
            background: "none",
            border: "1px solid #333",
            color: "#888",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          ↻ refresh
        </button>
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
        {loading ? (
          <div className="loading">Loading…</div>
        ) : error ? (
          <div className="error" style={{ color: "#f87171", padding: 24 }}>
            Failed to load registry data: {error.message}
          </div>
        ) : (
          currentTab.render({ artifacts, status })
        )}
      </main>
    </div>
  );
}
