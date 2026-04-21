import { useState } from "react";
import type { Artifact } from "../App";
import ArtifactDetail from "./ArtifactDetail";

const STATUS_OPTIONS = ["", "pending", "planned", "in-progress", "tests-written", "migrated", "reviewed", "needs-rework"];
const KIND_OPTIONS   = ["", "legacy-source", "target-source", "test", "module", "config", "shared-constants"];

export default function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const [filterStatus, setFilterStatus] = useState("");
  const [filterModule, setFilterModule] = useState("");
  const [filterKind, setFilterKind]     = useState("");
  const [selected, setSelected]         = useState<Artifact | null>(null);

  const modules = ["", ...Array.from(new Set(artifacts.map((a) => a.module).filter(Boolean)))];

  const filtered = artifacts.filter((a) =>
    (!filterStatus || a.status === filterStatus) &&
    (!filterModule || a.module === filterModule) &&
    (!filterKind   || a.kind   === filterKind)
  );

  return (
    <>
      <div className="filters">
        <select className="filter-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s || "All statuses"}</option>)}
        </select>
        <select className="filter-select" value={filterModule} onChange={(e) => setFilterModule(e.target.value)}>
          {modules.map((m) => <option key={m ?? ""} value={m ?? ""}>{m || "All modules"}</option>)}
        </select>
        <select className="filter-select" value={filterKind} onChange={(e) => setFilterKind(e.target.value)}>
          {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k || "All kinds"}</option>)}
        </select>
        <span style={{ marginLeft: "auto", color: "#555", fontSize: 12 }}>{filtered.length} / {artifacts.length}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Role</th>
              <th>Module</th>
              <th>Wave</th>
              <th>Status</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="empty">No artifacts match filters.</td></tr>
            )}
            {filtered.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setSelected(a === selected ? null : a)}>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{a.id}</td>
                <td><span style={{ color: "#94a3b8", fontSize: 12 }}>{a.role ?? "—"}</span></td>
                <td><span className="module-tag">{a.module ?? "—"}</span></td>
                <td>{a.wave != null ? <span className="wave-chip">wave {a.wave}</span> : <span style={{ color: "#333" }}>—</span>}</td>
                <td><span className={`badge ${a.status}`}>{a.status}</span></td>
                <td><span className="path">{a.path}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <ArtifactDetail artifact={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
