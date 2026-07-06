import React from "react";
import { useArtifacts, useEvents, useSessions, useSociety } from "../hooks";
import type { LifecycleStep, SocietyRole, SocietyViewData } from "../types";
import { classifyRole } from "../utils/roles";
import { relativeTime } from "../utils/time";

export interface SocietyViewProps {
  data?: SocietyViewData;
}

const roleTokens: Record<SocietyRole, string> = {
  builder: "var(--text-accent)",
  critic: "var(--text-warning)",
  arbiter: "var(--text-pro)",
};

const stepToken = (kind: LifecycleStep["kind"]) => {
  if (kind === "gate") return "var(--text-success)";
  if (kind === "rejection") return "var(--text-danger)";
  return roleTokens[kind];
};

const roleLabel = (role: SocietyRole) => role[0].toUpperCase() + role.slice(1);

function LiveSocietyView() {
  const { artifacts } = useArtifacts();
  const { sessions } = useSessions();
  const [selectedArtifactId, setSelectedArtifactId] = React.useState("");
  const { society } = useSociety(selectedArtifactId || undefined);
  const { events } = useEvents(selectedArtifactId);
  React.useEffect(() => {
    if (!selectedArtifactId) setSelectedArtifactId(sessions[0]?.id ?? artifacts[0]?.id ?? "");
  }, [artifacts, selectedArtifactId, sessions]);

  const artifact = artifacts.find((item) => item.id === selectedArtifactId);
  const detail = society?.artifact;
  const steps: LifecycleStep[] = [
    ...events.map((event) => ({
      id: event.id,
      kind: (/reject|rework/i.test(event.event_type) ? "rejection" : classifyRole(event.agent)) as LifecycleStep["kind"],
      title: event.event_type.split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "),
      relativeTime: relativeTime(event.created_at),
      description: event.note,
    })),
    ...(detail?.evidence ?? []).map((evidence) => ({ id: evidence.evidence_id, kind: "critic" as const, title: "Critic submitted evidence", relativeTime: relativeTime(evidence.created_at), evidence: [evidence] })),
    ...(detail?.arbitration ?? []).map((decision) => ({ id: decision.decision_id, kind: decision.decision === "rejected" ? "rejection" as const : "arbiter" as const, title: decision.decision === "rejected" ? "Arbiter rejected" : "Arbiter accepted", relativeTime: relativeTime(decision.decided_at), decision })),
  ].sort((left, right) => (left.relativeTime ?? "").localeCompare(right.relativeTime ?? ""));
  if ((detail?.evidence ?? []).some((row) => row.pass) && (detail?.arbitration ?? []).some((row) => row.decision === "approved")) {
    steps.splice(Math.max(0, steps.length - 1), 0, { id: "evidence-gate", kind: "gate", title: "Gate: independent passing evidence" });
  }
  const roleTotal = (role: SocietyRole) => Object.entries(society?.roles ?? {}).reduce((sum, [agent, count]) => sum + (classifyRole(agent) === role ? count : 0), 0);
  const lanes = (["builder", "critic", "arbiter"] as SocietyRole[]).map((role) => ({
    role,
    activeLabel: role === "arbiter" ? `${society?.evidence.artifacts_awaiting_arbitration ?? 0} pending` : `${roleTotal(role)} active`,
    artifacts: sessions.filter((session) => classifyRole(session.claimed_by) === role).map((session) => ({ artifactId: session.id, name: session.path.split("/").pop() ?? session.id, agentId: session.claimed_by, state: session.stalled ? `claimed ${session.claimed_minutes_ago ?? 0}m · stalled` : `claimed ${session.claimed_minutes_ago ?? 0}m` })),
  }));
  if (selectedArtifactId && !lanes.some((lane) => lane.artifacts.some((item) => item.artifactId === selectedArtifactId))) {
    lanes[0].artifacts.unshift({ artifactId: selectedArtifactId, name: artifact?.path.split("/").pop() ?? selectedArtifactId, agentId: artifact?.claimed_by ?? null, state: artifact?.status ?? "recorded" });
  }
  const data: SocietyViewData = {
    initialArtifactId: selectedArtifactId,
    lanes,
    lifecycles: selectedArtifactId ? [{ artifactId: selectedArtifactId, artifactName: artifact?.path.split("/").pop() ?? selectedArtifactId, status: artifact?.acceptance_state?.toLowerCase() ?? artifact?.status ?? "recorded", steps }] : [],
  };
  return <SocietyViewContent data={data} selectedId={selectedArtifactId} onSelect={setSelectedArtifactId} />;
}

function SocietyViewContent({ data, selectedId, onSelect }: { data: SocietyViewData; selectedId?: string; onSelect?: (id: string) => void }) {
  const [selectedArtifactId, setSelectedArtifactId] = React.useState(data.initialArtifactId);
  const effectiveId = selectedId ?? selectedArtifactId;
  const lifecycle = data.lifecycles.find((item) => item.artifactId === effectiveId);

  return (
    <section className="society-view" aria-labelledby="society-title">
      <style>{`
        .society-view { max-width: 960px; margin: 0 auto; }
        .society-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 4px 0 14px; }
        .society-title { font-size: 18px; font-weight: 500; }
        .society-legend { display: flex; gap: 12px; margin-left: auto; }
        .society-legend-item { display: inline-flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 11px; }
        .society-dot { width: 8px; height: 8px; border-radius: 50%; }
        .society-lanes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
        .society-lane { padding: 12px; border-radius: 12px; background: var(--surface-1); }
        .society-lane-head { display: flex; align-items: center; justify-content: space-between; }
        .society-role { font-size: 13px; font-weight: 500; }
        .society-active { color: var(--text-muted); font-size: 11px; }
        .society-chip { display: block; width: 100%; margin-top: 8px; padding: 8px 10px; border: .5px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--text-primary); cursor: pointer; text-align: left; }
        .society-chip:hover, .society-chip.selected { border-color: var(--text-accent); }
        .society-chip-name { font-size: 12px; font-weight: 500; }
        .society-chip-meta { color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        .society-badge { display: inline-block; padding: 2px 7px; border-radius: 20px; font-size: 10px; font-weight: 500; }
        .society-rejected { margin-left: 5px; background: var(--bg-danger); color: var(--text-danger); }
        .society-panel { padding: 16px; border: .5px solid var(--border); border-radius: 12px; background: var(--surface-2); }
        .society-panel-head { display: flex; align-items: center; margin-bottom: 14px; }
        .society-heading { color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .society-status { margin-left: auto; padding: 3px 9px; border-radius: 20px; background: var(--bg-success); color: var(--text-success); font-size: 12px; font-weight: 500; }
        .society-status.rejected { background: var(--bg-danger); color: var(--text-danger); }
        .society-step { position: relative; padding: 0 0 16px 22px; border-left: 2px solid var(--border); }
        .society-step:last-child { border-left-color: transparent; }
        .society-timeline-dot { position: absolute; top: 1px; left: -7px; width: 12px; height: 12px; border: 2px solid var(--surface-2); border-radius: 50%; }
        .society-step-head { display: flex; gap: 8px; }
        .society-step-title { font-size: 13px; font-weight: 500; }
        .society-time { margin-left: auto; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        .society-description { color: var(--text-secondary); font-size: 12px; }
        .society-evidence { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 9px; border-radius: var(--radius); background: var(--surface-1); font-size: 12px; }
        .society-pass { background: var(--bg-success); color: var(--text-success); }
        .society-fail { background: var(--bg-danger); color: var(--text-danger); }
        .society-evidence-command { color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        .society-evidence-summary { margin-left: auto; color: var(--text-secondary); }
        .society-gate { display: inline-block; padding: 8px 10px; border-radius: var(--radius); background: var(--bg-success); color: var(--text-success); font-size: 12px; }
        .society-empty { color: var(--text-muted); font-size: 12px; }
        .society-footnote { margin-top: 10px; padding: 0 2px; color: var(--text-muted); font-size: 11px; }
        @media (max-width: 680px) { .society-lanes { grid-template-columns: 1fr; } }
      `}</style>

      <div className="society-top">
        <h2 className="society-title" id="society-title">Agent society</h2>
        <div className="society-legend" aria-label="Role colors">
          {data.lanes.map((lane) => (
            <span className="society-legend-item" key={lane.role}>
              <span className="society-dot" style={{ background: roleTokens[lane.role] }} />
              {roleLabel(lane.role)}
            </span>
          ))}
        </div>
      </div>

      <div className="society-lanes">
        {data.lanes.map((lane) => (
          <section className="society-lane" aria-label={`${roleLabel(lane.role)} lane`} key={lane.role}>
            <div className="society-lane-head">
              <h3 className="society-role" style={{ color: roleTokens[lane.role] }}>{roleLabel(lane.role)}</h3>
              <span className="society-active">{lane.activeLabel}</span>
            </div>
            {lane.artifacts.map((artifact) => (
              <button
                aria-pressed={effectiveId === artifact.artifactId}
                className={`society-chip ${effectiveId === artifact.artifactId ? "selected" : ""}`}
                key={`${lane.role}-${artifact.artifactId}`}
                onClick={() => onSelect ? onSelect(artifact.artifactId) : setSelectedArtifactId(artifact.artifactId)}
                type="button"
              >
                <span className="society-chip-name">
                  {artifact.name}
                  {artifact.rejected && <span className="society-badge society-rejected">rejected</span>}
                </span>
                <span className="society-chip-meta">
                  {artifact.agentId ? `${artifact.agentId} · ` : ""}{artifact.state}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>

      <section className="society-panel" aria-live="polite">
        {lifecycle ? (
          <>
            <div className="society-panel-head">
              <h3 className="society-heading">{lifecycle.artifactName} — lifecycle</h3>
              <span className={`society-status ${lifecycle.status.startsWith("rejected") ? "rejected" : ""}`}>{lifecycle.status}</span>
            </div>
            <div>
              {lifecycle.steps.map((step) => (
                <div className="society-step" key={step.id}>
                  <span className="society-timeline-dot" style={{ background: stepToken(step.kind) }} />
                  {step.kind === "gate" ? (
                    <div className="society-gate">{step.title}</div>
                  ) : (
                    <>
                      <div className="society-step-head">
                        <span className="society-step-title" style={{ color: step.kind === "arbiter" ? roleTokens.arbiter : undefined }}>{step.title}</span>
                        {step.relativeTime && <time className="society-time">{step.relativeTime}</time>}
                      </div>
                      {step.description && <p className="society-description">{step.description}</p>}
                      {step.evidence?.map((row) => (
                        <div className="society-evidence" key={row.evidence_id}>
                          <span className={`society-badge ${row.pass ? "society-pass" : "society-fail"}`}>{row.pass ? "PASS" : "FAIL"}</span>
                          <span className="society-evidence-command">{row.evidence_type} · {row.command} · exit {row.exit_code}</span>
                          <span className="society-evidence-summary">{row.pass ? `#${row.evidence_id}` : row.summary}</span>
                        </div>
                      ))}
                      {step.decision && (
                        <p className="society-description">
                          {step.decision.arbiter} → reviewed · cites {step.decision.evidence_ids.split(",").map((id) => `#${id}`).join(", ")} · {step.decision.reason}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : <p className="society-empty">No lifecycle events recorded for this artifact.</p>}
      </section>

      <p className="society-footnote">The rejection and rework loop back to Builder are the conflict-resolution path — acceptance only follows independent, passing, executable proof.</p>
    </section>
  );
}

export default function SocietyView({ data }: SocietyViewProps) {
  return data ? <SocietyViewContent data={data} /> : <LiveSocietyView />;
}
