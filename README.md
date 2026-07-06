# Migration Guild

A multi-agent system for evidence-gated legacy modernization.

## Quick Start

```bash
git clone https://github.com/iserifith/migration-guild.git
cd migration-guild
npm install
cd migration && npm install && cd ..
npm run build
node migration/guildctl/dist/cli.js --help
```

## Architecture

```mermaid
graph TB
    subgraph "Frontend"
        UI["Mission Control UI<br/>(React)"]
    end

    UI -->|"REST API"| CLI

    subgraph "CLI Layer"
        CLI["guildctl CLI<br/>(Node.js)"]
    end

    CLI -->|"Spawn Agents"| ORCH

    subgraph "Agent Society"
        ORCH["Orchestrator Agent"]
        ORCH --> CTX["Context Agent"]
        ORCH --> PLAN["Planner Agent"]
        ORCH --> ANA["Analyze Agent"]
        ORCH --> TEST["Test Agent"]
        ORCH --> CODE["Codegen Agent"]
        ORCH --> REV["Review Agent"]
        ORCH --> REM["Remediation Agent"]
    end

    subgraph "Registry (SQLite)"
        REG["Artifact Registry<br/>• Atomic Claims<br/>• Wave Planning<br/>• Status Transitions"]
    end

    subgraph "Evidence Layer"
        EV[".guild/evidence/<br/>• Dependency Scans<br/>• Static Analysis"]
        RUNS[".guild/runs/<br/>• Run Ledgers<br/>• Prompt Logs"]
    end

    subgraph "Alibaba Cloud"
        QWEN["Qwen Cloud<br/>(DashScope API)<br/>dashscope-intl.aliyuncs.com"]
    end

    subgraph "Workspace"
        LEG["legacy/<br/>(read-only)"]
        MOD["modern/<br/>(write target)"]
    end

    CTX -->|"Read"| LEG
    CTX -->|"Write"| EV
    CTX -->|"Claim"| REG

    PLAN -->|"Read"| EV
    PLAN -->|"Write"| REG

    ANA -->|"Read"| LEG
    ANA -->|"Write"| EV

    TEST -->|"Write"| MOD
    TEST -->|"Update"| REG

    CODE -->|"Write"| MOD
    CODE -->|"Update"| REG

    REV -->|"Read"| LEG
    REV -->|"Read"| MOD
    REV -->|"Verdict"| REG

    REM -->|"Recover"| REG

    CTX -.->|"API"| QWEN
    PLAN -.->|"API"| QWEN
    ANA -.->|"API"| QWEN
    TEST -.->|"API"| QWEN
    CODE -.->|"API"| QWEN
    REV -.->|"API"| QWEN
    REM -.->|"API"| QWEN

    CLI -->|"Status"| REG
    CLI -->|"Read"| EV
    CLI -->|"Read"| RUNS

    style QWEN fill:#ff6a00,stroke:#333,stroke-width:2px,color:#fff
    style REG fill:#4a90d9,stroke:#333,stroke-width:2px,color:#fff
    style UI fill:#7b68ee,stroke:#333,stroke-width:2px,color:#fff
    style CLI fill:#7b68ee,stroke:#333,stroke-width:2px,color:#fff
    style ORCH fill:#e74c3c,stroke:#333,stroke-width:2px,color:#fff
    style LEG fill:#95a5a6,stroke:#333,stroke-width:2px,color:#fff
    style MOD fill:#27ae60,stroke:#333,stroke-width:2px,color:#fff
```

## Tracks

**Track 3: Agent Society** — Multi-agent coordination through a shared registry

## Tech Stack

- **TypeScript** / Node.js
- **SQLite** (WAL mode, concurrent reads)
- **OpenAI-compatible API** (Qwen Cloud / DashScope)
- **React** (Mission Control UI)

## License

MIT
...
