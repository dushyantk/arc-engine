-- Production memory. Mirrors ARCHITECTURE.md section 4 and the typed
-- contracts in lib/schemas/index.ts / server/models/contracts.py.
-- Semi-structured fields (character_identity, costume, generation_settings,
-- qc_findings, ...) are agent-authored text/JSON; validation happens at the
-- Pydantic/Zod boundary before insert, not in ClickHouse's column types.

CREATE DATABASE IF NOT EXISTS dailies;

CREATE TABLE IF NOT EXISTS dailies.continuity_fingerprints
(
    show                      String,
    sequence                  String,
    shot                      String,
    version                   UInt32,
    character_identity        String,
    costume                   String,
    props                     String,
    environment               String,
    time_of_day               String,
    lighting_direction        String,
    camera                    String,
    lens_language             String,
    screen_direction          String,
    palette                   Array(String),
    approved_reference_frames Array(String),
    generation_prompt         String,
    generation_settings       String, -- JSON
    qc_findings               String, -- JSON array snapshot; dailies.qc_findings holds the granular rows
    supervisor_notes          String,
    revision_reason           String DEFAULT '',
    approval_status           Enum8('pending' = 1, 'generating' = 2, 'reviewing' = 3, 'revise' = 4, 'approved' = 5, 'needs_human' = 6),
    extracted_at               DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (show, sequence, shot, extracted_at);

CREATE TABLE IF NOT EXISTS dailies.qc_findings
(
    shot_id            String, -- Postgres shots.id
    version            UInt32,
    category           String,
    verdict            Enum8('pass' = 1, 'fail' = 2, 'warning' = 3),
    frame_range_start  Nullable(UInt32),
    frame_range_end    Nullable(UInt32),
    description        String,
    severity           Enum8('info' = 1, 'warning' = 2, 'critical' = 3),
    created_at         DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (shot_id, version, created_at);

CREATE TABLE IF NOT EXISTS dailies.agent_decision_log
(
    run_id      String,
    agent_name  Enum8('planner' = 1, 'generation_adapter' = 2, 'critic' = 3, 'revision_agent' = 4, 'approval_gate' = 5),
    step        String,
    input_ref   String,
    output_ref  String,
    model       String,
    tokens_in   UInt32,
    tokens_out  UInt32,
    cost_usd    Decimal(10, 6),
    latency_ms  UInt32,
    created_at  DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (run_id, created_at);
