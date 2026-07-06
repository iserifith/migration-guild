import React from "react";
import { useArtifacts, useEvents, useSessions, useSociety, useStatus, useWavePlan } from "../hooks";
import type { ActivityTone, MissionControlData, SocietyRole } from "../types";
import { classifyRole } from "../utils/roles";
import { relativeTime } from "../utils/time";

export interface MissionControlProps {
  data?: MissionControlData;
}

const toneToken = {
  neutral: "var(--text-primary)",
  success: "var(--text-success)",
  warning: "var(--text-warning)",
  accent: "var(--text-accent)",
  builder: "var(--text-accent)",
  critic: "var(--text-warning)",
  arbiter: "var(--text-pro)",
  danger: "var(--text-danger)",
} as const;

const roleTokens: Record<SocietyRole, { foreground: string; background: string }> = {
  builder: { foreground: "var(--text-accent)", background: "var(--bg-accent)" },
  critic: { foreground: "var(--text-warning)", background: "var(--bg-warning)" },
  arbiter: { foreground: "var(--text-pro)", background: "var(--bg-pro)" },
};

function LiveMissionControl() {
  const statusHook = useStatus();
  const societyHook = useSociety();
  const wavePlanHook = useWavePlan();
  const sessionsHook = useSessions();
  const artifactsHook = useArtifacts();
  const { status } = statusHook;
  const { society } = societyHook;
  const { wavePlan } = wavePlanHook;
  const { sessions } = sessionsHook;
  const { artifacts } = artifactsHook;
  const activityArtifactId = sessions[0]?.id ?? artifacts[0]?.id ?? "";
  const eventsHook = useEvents(activityArtifactId);
  const { events } = eventsHook;
  const errors = [statusHook, societyHook, wavePlanHook, sessionsHook, artifactsHook, eventsHook]
    .map((hook) => hook.error)
    .filter((error): error is Error => error !== null);
  const total = status?.files.total ?? 0;
  const completed = status?.files.completed ?? 0;
  const roleCount = (role: SocietyRole) => Object.entries(society?.roles ?? {}).reduce((sum, [agent, count]) => sum + (classifyRole(agent) === role ? count : 0), 0);
  const data: MissionControlData = {
    metrics: [
      { label: "Completion", value: `${total ? Math.round(completed / total * 100) : 0}%`, detail: `${completed} / ${total} artifacts`, tone: "neutral" },
      { label: "Evidence pass rate", value: `${Math.round((society?.evidence.pass_rate ?? 0) * 100)}%`, detail: `${society?.evidence.passed ?? 0} of ${society?.evidence.total ?? 0} proofs`, tone: "success" },
      { label: "Awaiting arbitration", value: String(society?.evidence.artifacts_awaiting_arbitration ?? 0), detail: "Proof ready, unjudged", tone: "warning" },
      { label: "In progress", value: String(status?.files.in_progress ?? 0), detail: `${sessions.length} active claims`, tone: "neutral" },
    ],
    society: [
      { role: "builder", action: "Proposes → migrated", count: `${roleCount("builder")} active` },
      { role: "critic", action: "Runs tests → evidence", count: `${roleCount("critic")} active` },
      { role: "arbiter", action: "Accepts from proof", count: `${society?.evidence.artifacts_awaiting_arbitration ?? 0} pending` },
    ],
    waves: wavePlan.map((wave) => {
      const done = (wave.by_status.completed ?? 0) + (wave.by_status.reviewed ?? 0);
      const progress = wave.total ? Math.round(done / wave.total * 100) : 0;
      return { label: `Wave ${wave.wave}`, status: `${done}/${wave.total} done`, progress, tone: progress === 100 ? "success" : progress === 0 ? "warning" : "accent" };
    }),
    activity: events.slice(0, 6).map((event) => {
      const role = classifyRole(event.agent);
      return { id: event.id, role: role[0].toUpperCase() + role.slice(1), message: event.note, relativeTime: relativeTime(event.created_at), tone: (/reject|fail/i.test(event.event_type) ? "danger" : role) as ActivityTone };
    }),
  };
  return (
    <>
      {errors.length > 0 && (
        <div style={{ color: "var(--text-danger)", padding: "8px 12px", fontSize: 12 }}>
          {errors.map((error, index) => (
            <div key={index}>{error.message}</div>
          ))}
        </div>
      )}
      <MissionControlView data={data} />
    </>
  );
}

function MissionControlView({ data }: { data: MissionControlData }) {
  return (
    <section className="mission-control" aria-label="Mission Control overview">
      <style>{`
        .mission-control { max-width: 960px; margin: 0 auto; }
        .mission-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
        .mission-card { padding: 14px 16px; border-radius: 12px; background: var(--surface-1); }
        .mission-label { color: var(--text-muted); font-size: 12px; }
        .mission-number { color: var(--text-primary); font-size: 26px; font-weight: 500; line-height: 1.1; }
        .mission-suffix { margin-left: 1px; color: var(--text-muted); font-size: 14px; }
        .mission-detail { color: var(--text-muted); font-size: 12px; }
        .mission-panel { padding: 16px; border: .5px solid var(--border); border-radius: 12px; background: var(--surface-2); }
        .mission-society { margin-bottom: 14px; }
        .mission-heading { margin: 0 0 10px; color: var(--text-secondary); font-size: 13px; font-weight: 500; }
        .mission-flow { display: flex; align-items: stretch; gap: 8px; }
        .mission-node { flex: 1; padding: 12px; border-radius: 12px; text-align: center; }
        .mission-role { font-size: 13px; font-weight: 500; }
        .mission-action { font-size: 11px; }
        .mission-count { margin-top: 4px; color: var(--text-secondary); font-size: 11px; }
        .mission-arrow { display: flex; align-items: center; color: var(--text-muted); font-size: 18px; }
        .mission-gate { display: flex; min-width: 46px; flex-direction: column; align-items: center; justify-content: center; color: var(--text-success); font-size: 11px; }
        .mission-shield { font-size: 20px; }
        .mission-note { margin-top: 8px; color: var(--text-muted); font-size: 11px; }
        .mission-lower { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .mission-wave-list { display: flex; flex-direction: column; gap: 12px; }
        .mission-wave-meta { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 12px; }
        .mission-wave-name { color: var(--text-secondary); }
        .mission-bar { height: 8px; overflow: hidden; border-radius: 6px; background: var(--surface-0); }
        .mission-bar-fill { height: 100%; border-radius: 6px; }
        .mission-activity { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: .5px solid var(--border); color: var(--text-secondary); font-size: 12px; }
        .mission-activity:last-child { border-bottom: none; }
        .mission-dot { font-size: 12px; line-height: 1; }
        .mission-activity-role { font-weight: 500; }
        .mission-time { margin-left: auto; color: var(--text-muted); }
        .mission-heading .pulse { display: inline-block; margin-right: 6px; vertical-align: 1px; }
        @media (max-width: 760px) {
          .mission-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .mission-lower { grid-template-columns: 1fr; }
          .mission-flow { display: grid; grid-template-columns: 1fr auto 1fr; }
          .mission-gate { grid-column: 2; }
          .mission-node:last-child { grid-column: 3; }
        }
        @media (max-width: 480px) {
          .mission-kpis { grid-template-columns: 1fr; }
          .mission-flow { display: flex; flex-direction: column; }
          .mission-arrow { justify-content: center; transform: rotate(90deg); }
          .mission-gate { min-height: 46px; }
        }
      `}</style>

      <div className="mission-kpis">
        {data.metrics.map((metric) => (
          <article className="mission-card" key={metric.label}>
            <div className="mission-label">{metric.label}</div>
            <div className="mission-number" style={{ color: toneToken[metric.tone] }}>
              {metric.value}
              {metric.suffix && <span className="mission-suffix">{metric.suffix}</span>}
            </div>
            <div className="mission-detail">{metric.detail}</div>
          </article>
        ))}
      </div>

      <section className="mission-panel mission-society" aria-labelledby="society-heading">
        <h2 className="mission-heading" id="society-heading">
          Agent society — proposal must survive proof before acceptance
        </h2>
        <div className="mission-flow">
          {data.society.map((node, index) => {
            const tokens = roleTokens[node.role];
            return (
              <React.Fragment key={node.role}>
                {index === 1 && <span className="mission-arrow" aria-hidden="true">→</span>}
                {index === 2 && (
                  <span className="mission-gate">
                    <span className="mission-shield" aria-hidden="true">⛨</span>
                    Evidence gate
                  </span>
                )}
                <div className="mission-node" style={{ background: tokens.background }}>
                  <div className="mission-role" style={{ color: tokens.foreground }}>
                    {node.role[0].toUpperCase() + node.role.slice(1)}
                  </div>
                  <div className="mission-action" style={{ color: tokens.foreground }}>{node.action}</div>
                  <div className="mission-count">{node.count}</div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <p className="mission-note">Arbiter must differ from evidence producer — no self-approval</p>
      </section>

      <div className="mission-lower">
        <section className="mission-panel" aria-labelledby="pipeline-heading">
          <h2 className="mission-heading" id="pipeline-heading">Wave pipeline</h2>
          <div className="mission-wave-list">
            {data.waves.map((wave) => (
              <div key={wave.label}>
                <div className="mission-wave-meta">
                  <span className="mission-wave-name">{wave.label}</span>
                  <span style={{ color: toneToken[wave.tone] }}>{wave.status}</span>
                </div>
                <div className="mission-bar" role="progressbar" aria-label={`${wave.label} progress`} aria-valuenow={wave.progress} aria-valuemin={0} aria-valuemax={100}>
                  <div className="mission-bar-fill" style={{ width: `${wave.progress}%`, background: toneToken[wave.tone] }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mission-panel" aria-labelledby="activity-heading">
          <h2 className="mission-heading" id="activity-heading"><span className="pulse" />Live activity</h2>
          <div>
            {data.activity.map((event) => (
              <div className="mission-activity" key={event.id}>
                <span className="mission-dot" style={{ color: toneToken[event.tone] }} aria-hidden="true">●</span>
                <span><span className="mission-activity-role">{event.role}</span> {event.message}</span>
                <time className="mission-time">{event.relativeTime}</time>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

export default function MissionControl({ data }: MissionControlProps) {
  return data ? <MissionControlView data={data} /> : <LiveMissionControl />;
}
