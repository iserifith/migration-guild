# PRD: Wave-Pipeline Token & Cost Telemetry

**Codename:** `wave-budget`
**Status:** Draft v0.1
**Owner:** TBD
**Date:** 2026-07-20

---

## Problem

Teams executing batch-based AI migrations with Migration Guild lack native visibility into how LLM token consumption correlates with file progress across pipeline waves. This creates unpredictability in budgeting and resource planning — engineering leads cannot forecast costs or spot high-consumption anomalies early. Anomalies surface on the invoice, not when the spend spikes.

## Goal

Surface token and cost telemetry **directly inside the existing wave-pipeline view**, with a live projection of total wave budget. Success means teams can forecast migration costs with high accuracy before triggering subsequent waves.

## Core Assumption

> Users want token usage **linked directly to wave-pipeline status** rather than tracked as a standalone billing dashboard. Standalone dashboards are deprioritised because they break context during wave triage.

**Validation gate:** 5-user smoke test — does the forecast badge change wave-trigger behaviour vs. baseline?

## Non-goals (v1)

- Standalone billing dashboard.
- Multi-tenant spend rollups.
- Pricing negotiation UI.
- Replay / time-travel debugging.

## User Stories

1. As a lead, I see per-file tokens + cost beside file status (`pending | running | done | failed`).
2. As a lead, I see a **live wave-budget bar** (spent / projected / cap).
3. As a lead, I see **anomaly chips inline** (e.g. ⚠ `+2σ above wave mean cost/LOC`).
4. As a lead, before *Trigger next wave*, I see a **forecast range** ($low–$high) for the next wave.
5. As an operator, I see my worker's contribution to wave spend (coder / reviewer / arbiter).

## Proposed Experience

| Surface | Addition |
|---|---|
| File row | `tokens in/out`, `cost`, `cost/LOC`, `σ vs wave mean` |
| Wave header | actual · projected total · cap · "next wave: $X–$Y (n files)" |
| File row hover | token breakdown by call role |
| Anomaly chip | auto-renders on files > `mean + k·σ` |

## Functional Requirements

| # | Requirement |
|---|---|
| F1 | `migration/registry` emits `token_usage v1` event (model, in, out, latency, file_id, agent_role). |
| F2 | Wave rollup persists tokens + cost per file per wave (SQLite). |
| F3 | `GET /waves/:id/budget` → actual + projected + per-file breakdown. |
| F4 | `GET /waves/:id/forecast-next` → low / expected / high range. |
| F5 | Wave UI renders budget bar + cost column live (SSE or short-poll, ≤ 5s lag). |
| F6 | Anomaly rule: `file_cost > mean + k·σ` of completed files → emit `anomaly` event + UI chip. |
| F7 | Pricing table from config (Claude / GPT / Gemini / local-Qwen) with per-env override. |

## Non-functional Requirements

- **Lag:** budget bar updates ≤ 5s after file completes.
- **Accuracy:** forecast band contains actual next-wave cost ≥ 70% of historical waves (back-tested).
- **Privacy:** no prompt/completion content — counts + identifiers only.
- **Telemetry overhead:** < 1% of wave spend.

## Success Metrics

| Metric | Target |
|---|---|
| Forecast band hit-rate | ≥ 70% |
| Time-to-detect anomaly | < 1 wave completion cycle |
| Leads adjusting trigger based on forecast | ≥ 30% (proves real use) |
| Lead confidence in wave budget | ↑ vs baseline (survey, n≥5) |

## Rollout

- **MVP:** per-file cost column + wave spent/projected bar.
- **v1:** + forecast range + anomaly chip + live updates.
- **v2:** per-agent-role split + CSV/JSON export for finance.

## Open Questions

1. **Surface** — Quartz (web) or CLI/operator dashboard? Drives SSE vs poll.
2. **Pricing** — static config, live fetch, or per-env override? Drift risk.
3. **Anomaly threshold** — `mean + 2σ` default, or absolute `$/file` cap? Configurable?
4. **Forecast model** — naïve `$/file × queue` vs regression on prior wave actuals + model-mix.
5. **Currency** — USD only, or multi-currency view?
6. **Backfill** — can we replay historical waves to seed the model, or cold-start?
7. **Tenant scope** — are waves ever shared across cost-centers?

## Out of Scope

- Per-prompt token attribution.
- Negotiated rates / invoicing.
- Cross-wave spend heatmap (v3+).
