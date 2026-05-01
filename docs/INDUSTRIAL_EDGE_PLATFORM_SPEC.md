# Architectural Influence Specification: FORGE
> How the industrial DataOps patterns established by Litmus Edge, Litmus Edge Manager, and Litmus UNS should shape decision-making inside the FORGE repository. FORGE combines the Litmus data-platform pattern (device connectivity, broker spine, server roles, northbound sinks) with a full engineering collaboration and execution layer — a combination no single existing product delivers.

---

| Field | Value |
|-------|-------|
| **Product** | FORGE — Federated Operations, Research, Governance, and Engineering |
| **Repo** | [github.com/zbest1000/FORGE](https://github.com/zbest1000/FORGE) |
| **Version** | 2.0 |
| **Status** | Living document — update when architecture decisions are made |
| **Last updated** | 2026-04-30 |
| **Audience** | Engineers and architects contributing to the FORGE repo |

---

## What FORGE Is

FORGE is two things in one product — and both halves must be architectural equals:

**1. An industrial data platform** (the Litmus half): FORGE connects directly to OT devices via protocol drivers, normalizes all data through an internal broker spine, processes and stores it locally, and exposes it to any consuming system — as an OPC UA server, an MQTT broker, a REST/GraphQL API, and as northbound push flows to ERP systems, historians, and cloud platforms.

**2. An engineering collaboration and execution platform** (the FORGE half): Built on top of that data foundation, FORGE gives engineering teams the surfaces to act on what the data reveals — managing assets, work items, documents, drawings, incidents, approvals, and AI-assisted analysis from a single, self-hostable interface.

Neither half is optional. The collaboration features are only valuable because FORGE has real, live data behind them. The data platform is only actionable because FORGE has the collaboration layer where decisions get made.

The reference architecture (Litmus) builds the data half. FORGE builds both. Every architectural decision should be tested against both missions simultaneously.

---

## System Architecture

```
╔══════════════════════════════════════════════════════════════════════╗
║  SOUTHBOUND — Device Connectivity                                    ║
║  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  ║
║  │ Modbus   │ │ OPC UA   │ │   MQTT   │ │REST/HTTP │ │  SQL/    │  ║
║  │TCP/RTU   │ │ Client   │ │  Client  │ │  Poll    │ │ File/CSV │  ║
║  │(driver)  │ │(driver)  │ │(driver)  │ │(driver)  │ │(driver)  │  ║
║  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  ║
╚═══════╪═══════════╪═══════════╪═══════════╪═══════════╪════════════╝
        │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼
╔══════════════════════════════════════════════════════════════════════╗
║  BROKER SPINE — Internal Normalizing Message Bus                     ║
║  All data normalized to VQT Tags at this boundary.                  ║
║  No downstream module ever sees a raw protocol frame.               ║
║  (MQTT broker: Mosquitto/EMQX, or embedded NanoMQ)                  ║
╚══════════════════════════════════════════════════════════════════════╝
        │                   │                   │
        ▼                   ▼                   ▼
╔═══════════════╗   ╔═══════════════╗   ╔═══════════════════════════╗
║  PROCESSING   ║   ║   STORAGE     ║   ║  NORTHBOUND — Serving     ║
║  Flow engine  ║   ║  SQLite       ║   ║  & Sinking                ║
║  Alert rules  ║   ║  (config,     ║   ║  ┌──────────────────────┐ ║
║  Analytics    ║   ║  collab)      ║   ║  │ SERVERS (pull model): │ ║
║  KPI engine   ║   ║  InfluxDB     ║   ║  │  OPC UA Server        │ ║
║  ML inference ║   ║  (time-series)║   ║  │  MQTT Broker (ext.)   │ ║
╚═══════════════╝   ╚═══════════════╝   ║  │  REST / GraphQL API   │ ║
                                        ║  └──────────────────────┘ ║
                                        ║  ┌──────────────────────┐ ║
                                        ║  │ SINKS (push model):  │ ║
                                        ║  │  ERP (SAP, Oracle)   │ ║
                                        ║  │  Historians (PI,     │ ║
                                        ║  │    Cognite, InfluxDB)│ ║
                                        ║  │  Cloud (AWS, Azure,  │ ║
                                        ║  │    GCP)              │ ║
                                        ║  │  Webhooks / S3       │ ║
                                        ║  └──────────────────────┘ ║
╚═══════════════════════════════════════════════════════════════════════╝
        │
        ▼
╔══════════════════════════════════════════════════════════════════════╗
║  COLLABORATION LAYER — FORGE's unique value above the data platform  ║
║  Assets · Work Items · Documents · Drawings · CAD                   ║
║  Incidents · War Rooms · Approvals · Revision Control               ║
║  UNS Browser · i3X Explorer · AI Workspace · Search · Dashboards    ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## Table of Contents

1. [The Broker Spine](#1-the-broker-spine)
2. [The Tag — Atomic Data Abstraction](#2-the-tag--atomic-data-abstraction)
3. [Driver Plugin Architecture (Southbound)](#3-driver-plugin-architecture-southbound)
4. [Asset Model and ISA-95 Hierarchy](#4-asset-model-and-isa-95-hierarchy)
5. [Processing: Flow Engine and Analytics](#5-processing-flow-engine-and-analytics)
6. [Storage](#6-storage)
7. [Server Roles (Northbound — Pull Model)](#7-server-roles-northbound--pull-model)
8. [Data Sinks (Northbound — Push Model)](#8-data-sinks-northbound--push-model)
9. [Unified Namespace and i3X](#9-unified-namespace-and-i3x)
10. [Collaboration Layer](#10-collaboration-layer)
11. [Alerting, Alarms, and Incidents](#11-alerting-alarms-and-incidents)
12. [Offline-First and Resilience](#12-offline-first-and-resilience)
13. [Time and Timestamp Integrity](#13-time-and-timestamp-integrity)
14. [Observability and Self-Monitoring](#14-observability-and-self-monitoring)
15. [Security Architecture](#15-security-architecture)
16. [Configuration as Code](#16-configuration-as-code)
17. [REST and GraphQL API Design](#17-rest-and-graphql-api-design)
18. [Schema Evolution and Compatibility](#18-schema-evolution-and-compatibility)
19. [Performance Targets](#19-performance-targets)
20. [Deployment Models](#20-deployment-models)
21. [Design Philosophy](#21-design-philosophy)
22. [Anti-Patterns](#22-anti-patterns)
23. [Out of Scope for v1](#23-out-of-scope-for-v1)
24. [Success Criteria](#24-success-criteria)
25. [Glossary](#25-glossary)

---

## 1. The Broker Spine

The single most important architectural decision in the reference platform — and the one most worth carrying forward — is that **every internal module communicates through a normalizing message broker**. This is not a deployment detail. It is the contract that makes everything else possible.

### 1.1 The broker is the product's central nervous system

All data ingested from devices by drivers must be published to the broker as normalized Tags before any other module sees it. No module — the flow engine, the time-series store, the collaboration layer, the northbound sinks — ever communicates with a driver directly. They all subscribe to broker topics.

This single constraint is what makes protocol independence real. A dashboard, an alert rule, an ERP sink, and an OPC UA server can all consume the same temperature reading without knowing or caring that it came from a Modbus TCP register, a Siemens S7 data block, or an MQTT publish from a field gateway.

### 1.2 Broker requirements

- **Transport:** MQTT 3.1.1 / 5.0. The docker-compose already ships Mosquitto — this is the right call. For high-throughput deployments, EMQX or NanoMQ are acceptable alternatives.
- **Topic hierarchy:** `forge/{site}/{area}/{line}/{cell}/{asset}/{tag}` — ISA-95 aligned, matching the UNS namespace.
- **Retained messages:** The last known good value for every tag must be retained on the broker so new subscribers immediately receive current state without waiting for the next poll cycle.
- **QoS:** QoS 1 (at least once) is the default for all tag data. QoS 2 (exactly once) for command writebacks to assets.
- **Last-will/testament:** Each driver connection must register a last-will message so the broker publishes a quality-degraded sentinel tag if the driver crashes or disconnects unexpectedly.
- **Authentication:** All internal connections to the broker use mTLS or username/password credentials generated at startup. The broker must never be exposed without authentication.

### 1.3 Store-and-forward

When a northbound sink or processing module is unavailable, the broker must not drop data:

- **Disk-backed persistence:** The broker persists undelivered messages to disk. Data is not lost on broker restart.
- **Buffer capacity:** Default 72 hours of data at nominal throughput, configurable.
- **Eviction policy:** Oldest-first (FIFO) with an operator alert at 80% buffer capacity.
- **Ordered replay:** On reconnection, messages replay in chronological order with original source timestamps intact. Replay rate is throttled (configurable, default 1,000 messages/second) to avoid overwhelming reconnected consumers.
- **Dead-letter queue:** Messages that fail delivery after N retries move to a dead-letter topic, visible in the integration health panel for operator inspection.

### 1.4 The internal store.js relationship

`src/core/store.js` is the collaboration layer's reactive state bus — it handles UI mutations (asset updates, work item changes, document approvals). It is **not** the data-plane broker. The two must remain distinct:

- The broker (MQTT) carries high-frequency, real-time device data — thousands of tag updates per second.
- `store.js` carries low-frequency collaboration events — user actions, state transitions, audit events.
- The bridge between them is a **broker subscriber process** on the server that consumes tag data from MQTT, writes it to InfluxDB, evaluates alert rules, and emits store events when thresholds are crossed or incidents are auto-created.

Both buses use the same event envelope schema (see §2.3) so the collaboration layer can consume data-plane events without knowing their origin.

---

## 2. The Tag — Atomic Data Abstraction

A **Tag** is the single, universal data type that flows through every layer of the system. It is the contract between drivers and every downstream consumer. Every protocol driver translates its native concept (Modbus register, OPC UA node, MQTT payload field, SQL column value) into a Tag. No module downstream of a driver ever sees a raw protocol frame.

### 2.1 Required fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (stable URI path) | Globally unique within a FORGE instance. Never changes, even if the underlying device address changes. Format: `{site}/{area}/{line}/{asset}/{signal-name}` |
| `value` | typed: float, int, bool, string, JSON | Never stringly typed. The driver declares the canonical type. |
| `source_timestamp` | ISO 8601, millisecond precision | Time the value was observed at the source device. This is the authoritative timestamp. |
| `server_timestamp` | ISO 8601, millisecond precision | Time FORGE's driver received the value. Used for lag monitoring only. |
| `quality` | enum: `GOOD`, `BAD`, `UNCERTAIN`, `STALE`, `INITIALIZING` | Required on every tag. Consumers must check quality before acting on value. |
| `unit` | string (UCUM-compatible) | Required for all numeric tags. `""` for dimensionless. |
| `data_type` | enum | OPC UA DataTypes as the reference: `Float`, `Double`, `Int32`, `Int64`, `Boolean`, `String`, `ByteString` |
| `source_ref` | string | The driver-native address: Modbus register, OPC UA node ID, MQTT topic, SQL column |
| `asset_ref` | string | Foreign key to the asset in FORGE's asset model |
| `driver_id` | string | Which driver instance produced this tag |
| `metadata` | key-value map | Engineering range (min/max), alarm thresholds, ISA-95 path, custom labels |

### 2.2 Rules

- **Tags are immutable events.** A reading is never updated in place. The current value is always the most recent tag event with quality `GOOD`. State is derived, never stored as mutable.
- **Every driver outputs Tags and only Tags.** No driver may push raw frames, custom structs, or driver-specific objects to any other module.
- **All consumers accept Tags and only Tags.** The flow engine, alert engine, storage writer, northbound sinks, OPC UA server, and REST API all consume Tags from the broker. Zero direct driver access.
- **Quality is consumed, never ignored.** Any UI surface, analytics function, or northbound sink that displays or forwards a tag value must also surface its quality. Silently forwarding a BAD quality value to an ERP system is worse than forwarding nothing.

### 2.3 Event envelope (shared with store.js)

Both the data-plane broker and the collaboration store.js use a common envelope so events can flow between layers without format conversion:

```json
{
  "id": "uuid-v4",
  "type": "tag.reading | asset.updated | incident.created | ...",
  "source": "driver.modbus-01 | user.ui | system.alert-engine | ...",
  "timestamp": "2026-04-30T14:23:01.452Z",
  "actor": "user-id or system-id",
  "correlation_id": "uuid-v4 (optional)",
  "payload": { ... }
}
```

The `type` namespace is hierarchical and documented. New event types are additive — existing consumers ignore unknown types.

---

## 3. Driver Plugin Architecture (Southbound)

The driver architecture is FORGE's primary extensibility surface. It must be defined, frozen, and documented before any production driver is written. The contract is the product.

### 3.1 The driver contract

Every driver — whether built by the FORGE team, a partner, or a customer — implements the same interface:

```
initialize(config)      → validates config, allocates resources
connect()               → establishes connection to device
disconnect()            → graceful teardown
browse()                → returns discoverable tag list from device
poll(tagList)           → active polling for non-subscribable sources
subscribe(tagList)      → event-driven subscription where supported
write(tagId, value)     → writeback to device (optional, declared in capabilities)
health()                → returns { status, lastSuccess, errorRate, connectionState }
shutdown()              → forced teardown, cleans up resources
```

The contract also requires:
- **Config schema:** Each driver declares a typed JSON Schema for its configuration, which FORGE renders automatically as a UI form. No driver-specific UI code in the platform.
- **Capabilities declaration:** `{ canPoll: bool, canSubscribe: bool, canWrite: bool, supportedTransports: [...] }` — declared at load time.
- **Tag discovery:** `browse()` returns a list of available tags in the standard Tag schema so users can select which to import.
- **Error taxonomy:** Standardized error codes (`CONNECTION_REFUSED`, `AUTH_FAILED`, `TIMEOUT`, `BAD_ADDRESS`, `DEVICE_BUSY`) so the integration health panel can display actionable messages.

### 3.2 Driver isolation

Each driver instance runs in **process isolation** — a separate Node.js child process or worker thread — so a crashing driver cannot affect the broker, other drivers, or the collaboration layer. The parent process monitors driver health via the `health()` interface and restarts crashed drivers with exponential backoff (default cap: 5 restarts, then `FAULTED` state with operator alert).

Drivers are **hot-pluggable**: added, removed, started, and stopped at runtime without restarting FORGE. Adding a new Modbus device while Line 3 is running must not interrupt Line 1's data flow.

### 3.3 Driver SDK

The SDK must be public, versioned, and include:
- TypeScript/JSDoc type definitions for the driver contract.
- A reference driver implementation (synthetic/simulation data generator).
- A test harness that validates any driver against the contract without real hardware.
- Documentation sufficient for a developer to write a working driver in one day.

The simulation driver is not just a testing tool — it is the mechanism that allows FORGE to be evaluated and demoed without physical hardware. It must be a first-class, production-quality driver that can generate realistic waveforms, sensor drift, fault injection, and alarm conditions.

### 3.4 Protocol coverage targets

| Tier | Target | Protocols |
|------|--------|-----------|
| **Tier 1 — v1** | Launch | Modbus TCP, Modbus RTU (`modbus-serial` already present), OPC UA client (`node-opcua` already present), MQTT client (`mqtt` already present), REST/HTTP polling, SQL (`mssql` already present), file/CSV, simulation/synthetic |
| **Tier 2 — 12 months** | Near-term | Siemens S7-1200/1500, Allen-Bradley EtherNet/IP, BACnet/IP, OPC DA bridge, Kafka consumer, DNP3, SNMP |
| **Tier 3 — Partner** | Community | Vendor-specific: Hitachi, Mitsubishi, Emerson DeltaV, Yokogawa, Honeywell, FactoryTalk historians |

The reference platform ships 250+ drivers. Breadth matters: a customer who cannot connect their existing device cannot evaluate FORGE at all.

### 3.5 Device onboarding UX

- Network scanning / auto-discovery wizard for TCP-based protocols (Modbus TCP, OPC UA, BACnet).
- One-screen add flow: select driver → fill config form (auto-generated from driver's JSON Schema) → browse available tags → import selected tags.
- Bulk tag import via CSV with validation feedback — essential for sites with thousands of tags.
- **Live tag preview during configuration:** The operator sees actual values before saving. No "configure blind, hope it works."
- Tag simulation mode per driver: generates synthetic values so downstream flows, alert rules, and dashboards can be built and tested before physical hardware is connected.

---

## 4. Asset Model and ISA-95 Hierarchy

Tags exist within an asset context. Without the asset model, FORGE is a tag database with no semantics. The asset model is the structural layer that makes cross-asset analysis, cross-site comparison, and engineering collaboration possible.

### 4.1 Hierarchy

Five-level ISA-95 hierarchy by default, customer-configurable:

```
Enterprise
  └── Site
        └── Area
              └── Line / System
                    └── Asset (the leaf where tags, documents, work items, and incidents live)
```

Every FORGE object — tag, document, work item, drawing, incident — belongs to an asset node. Navigation, search, alert scoping, and AI context are all rooted in this hierarchy.

### 4.2 Asset node required fields

| Field | Notes |
|-------|-------|
| Unique ID (UUID) | Stable. Never changes on rename or move. |
| Hierarchical path | Derived from parent chain. Used as the MQTT topic prefix and OPC UA namespace path. |
| Display name | Human-readable. Can change without affecting the UUID. |
| Asset class / type | Links to the class schema (see §4.3). |
| Operational state | `RUNNING`, `STOPPED`, `MAINTENANCE`, `DECOMMISSIONED` |
| Alternate addresses | MQTT topic prefix, OPC UA node ID, i3X elementId, historian tag prefix |
| Geo-location | Lat/long (optional) |
| Collections | Tags, documents, drawings, work items, incidents — linked, not embedded |

### 4.3 Asset classes define expected schemas

An asset class (e.g., `Centrifugal Pump`) defines:
- The set of tags the asset is expected to expose (name, type, unit, normal range, alarm thresholds).
- The documents it should have (datasheet, maintenance procedure, P&ID reference).
- The KPIs that apply (OEE, MTBF, energy consumption).

Individual asset instances inherit the class schema and may have additional tags. The integration console shows unmapped expected tags prominently — "this pump is missing its bearing temperature mapping" — making onboarding gaps visible.

### 4.4 The hierarchy drives the MQTT topic and OPC UA address space

When a tag is registered under an asset, its broker topic and OPC UA node ID are **derived automatically** from the asset path:
- MQTT topic: `forge/atlas-industrial/north-plant/line-a/hx-01/inlet-temp`
- OPC UA node: `ns=2;s=atlas-industrial.north-plant.line-a.hx-01.inlet-temp`

There is no separate "mapping" step for the server roles. The asset hierarchy is the canonical namespace and all server representations are projections of it.

---

## 5. Processing: Flow Engine and Analytics

### 5.1 Visual flow engine

The product ships a visual, low-code data flow editor as the primary mechanism for processing, routing, and transformation. The buyer is an OT/controls engineer, not a software developer. Code is an escape hatch, not the expected path.

The reference implementation is **Node-RED**, and it is a defensible choice given FORGE's existing Node.js stack. An embedded Node-RED instance, isolated in its own process and communicating with the broker, is the fastest path to a production-grade visual flow engine.

**Required capabilities:**
- Drag-and-drop canvas with typed input/output ports.
- Built-in node palette: filter, transform, branch, merge, throttle, debounce, aggregate (windowed), calculate (formula), HTTP request, MQTT pub/sub, InfluxDB write, SQL write, tag writeback, schedule/timer, alert trigger, webhook call.
- **Custom function node:** sandboxed JavaScript (or Python subprocess) for cases the palette cannot cover. Sandbox prevents filesystem and network access and enforces CPU time limits.
- **Debug mode:** Step-through execution with per-node message inspection. Required — flows without debuggability are unmaintainable.
- **Simulation mode:** Inject synthetic tag values to test a flow before connecting live hardware.
- Import/export of flows as portable JSON. A flow exported from one FORGE instance imports and runs on another with no modification, assuming compatible driver configuration.
- Flow versioning with one-click rollback.
- Per-flow RBAC.
- Auto-restart on crash with exponential backoff (default cap: 5 retries → `FAULTED` state → operator alert).

### 5.2 Analytics and KPI library

Built-in analytics nodes (first-class palette entries, not custom scripts):

| Category | Functions |
|----------|-----------|
| Statistical | Moving average (SMA, EMA, WMA), standard deviation, Gaussian filter, histogram, percentile |
| Anomaly detection | Z-score, IQR outlier, isolation forest (lightweight) |
| Forecasting | ARIMA, linear regression, Holt-Winters |
| Signal processing | Low-pass / high-pass filter, FFT, peak detection |

Pre-built industrial KPI dashboards as one-click installs:

| KPI | Standard reference |
|-----|--------------------|
| OEE (Availability × Performance × Quality) | ISO 22400 |
| MTBF / MTTR | ISO 14224 |
| Uptime / Downtime | — |
| Cycle time, throughput, capacity utilization | ISA-95 |
| Energy consumption per unit | ISO 50001 |
| First-pass yield | — |

### 5.3 ML model inference

- Upload trained models (ONNX or TensorFlow Lite) and run inference at the FORGE server — not in the browser, not in the cloud.
- Models appear as flow nodes: receive a tag or tag array, emit a tag (prediction, anomaly score, classification label).
- Resource governance: configurable CPU and memory limits per model. The platform sheds inference load before shedding ingest.
- Training is explicitly out of scope. Train in the cloud; deploy to FORGE.

---

## 6. Storage

### 6.1 Two-database model

FORGE uses two databases for two distinct concerns. This separation must never be collapsed:

| Database | Engine | Purpose |
|----------|--------|---------|
| **Operational DB** | `better-sqlite3` (SQLite) | All collaboration objects: assets, work items, documents, drawings, incidents, approvals, users, roles, audit log, driver config, flow definitions, alert rules, integration mappings |
| **Time-series DB** | InfluxDB (via `@influxdata/influxdb-client`) | All tag readings: high-frequency VQT time-series, aggregates, flow outputs, KPI history |

SQLite is the right choice for the operational DB at self-hosted single-instance scale. It is synchronous, embedded, zero-configuration, and trivially backed up with `cp`. All queries must stay on the main thread or a dedicated worker — never from async paths that could cause WAL corruption.

InfluxDB may be embedded (self-hosted alongside FORGE via docker-compose) or external (an existing InfluxDB instance). The `@influxdata/influxdb-client` already handles both cases.

### 6.2 Time-series requirements

- **Configurable retention per tag or per asset class.** Default: raw data at source resolution for 30 days, 1-minute aggregates for 1 year, 1-hour aggregates indefinitely.
- **Downsampling / rollup tasks** run on a schedule and are defined alongside the retention policy, not separately.
- **Encryption at rest** on the InfluxDB volume. Key management: platform-managed by default; customer-managed (Vault, KMS) for enterprise deployments.
- **Compression:** InfluxDB's native compression (delta + LZ4) is adequate. Target: 10:1 compression ratio on industrial time-series. Size estimates in documentation must use compressed volume.
- Tag readings must be queryable from flow engine nodes, from the collaboration layer's asset detail screen, and from external clients via the REST and GraphQL APIs.

### 6.3 Backup and recovery

- `npm run backup` creates a consistent snapshot of both databases (SQLite WAL checkpoint + InfluxDB backup) and writes a timestamped archive.
- Restore is a single command: `npm run restore`.
- Backup must be automatable (cron-friendly) and its output must be uploadable to S3-compatible object storage as a sink option (see §8).
- Recovery time objective: a full restore from backup must complete in under 10 minutes for databases up to 50 GB.

---

## 7. Server Roles (Northbound — Pull Model)

FORGE is a **server** as well as a client. External systems — SCADA, MES, BI tools, other FORGE instances — must be able to pull data from FORGE without needing direct access to the broker or the database.

### 7.1 OPC UA Server

FORGE must expose its full tag tree as an **OPC UA server** so any OPC UA client (SCADA, MES, historian, BI tool) can browse and subscribe to FORGE data.

- The OPC UA address space is derived automatically from the asset hierarchy (see §4.4). No manual address-space authoring required.
- Supported services: Browse, Read, Write (role-gated), Subscribe (monitored items + subscriptions), Historical Read (backed by InfluxDB).
- Security modes: None (dev only), Sign, SignAndEncrypt. Certificate management UI required.
- The OPC UA server is the canonical path for legacy SCADA and MES systems that cannot consume REST or MQTT. It is not optional for industrial deployments.
- `node-opcua` is the right library choice — already in the optional dependencies. It must move to a required dependency when the OPC UA server is implemented.

### 7.2 MQTT Broker (External-Facing)

The internal Mosquitto broker handles driver-to-platform communication. A **second, externally-accessible MQTT broker endpoint** (or a bridge on the same broker with separate ACLs) allows:
- External devices and field gateways to **publish into FORGE** directly (FORGE as subscriber/server).
- External consumers to **subscribe to FORGE data** (FORGE as publisher/broker).
- Sparkplug B support: birth/death certificates, sequence numbers, typed metrics — not just raw JSON topics.

This broker endpoint must have independent authentication (separate credentials from the internal broker), configurable topic ACLs per-user, and TLS.

### 7.3 REST API

The REST API (Fastify + RapiDoc) is FORGE's primary integration surface for modern systems. Requirements:

- Full read/write coverage of all FORGE objects: assets, tags, work items, documents, incidents, alert rules, integration mappings, flows.
- **The web UI is a client of this API.** No internal shortcuts. If the UI can do it, external systems can too via the same endpoints.
- Tag value query: `GET /api/v1/tags/{id}/value` (latest VQT), `GET /api/v1/tags/{id}/history?from=&to=&resolution=` (time-series from InfluxDB).
- Tag write: `POST /api/v1/tags/{id}/write` (authenticated, role-gated, audit-logged, proxied to the driver writeback interface).
- Consistent response envelope, versioned URL paths, machine-readable error codes, OpenAPI 3.0 spec published (see §17).

### 7.4 GraphQL API

`mercurius` (already a production dependency) provides the GraphQL layer. GraphQL serves:
- Complex nested queries: "give me all assets on Line 3, with their latest tag values and open work items, in one request."
- Subscriptions: real-time tag updates pushed to GraphQL subscribers (backed by broker topics).
- The i3X Explorer already exercises this pattern in-process — the GraphQL API formalizes it for external consumers.

GraphQL and REST APIs must share the same authentication and authorization layer. A user's role permissions apply identically to both.

---

## 8. Data Sinks (Northbound — Push Model)

FORGE pushes data out to external systems on a configured schedule, event trigger, or continuous stream. Every sink is bidirectional by default: it can both receive tag data from FORGE and send commands or records back.

### 8.1 Required sink destinations

| Category | Destinations |
|----------|-------------|
| **Time-series / Historian** | InfluxDB (write, already partially implemented), AVEVA PI System, Cognite Data Fusion, Aspen IP.21 |
| **Cloud platforms** | AWS IoT SiteWise, AWS Kinesis, Azure IoT Hub, Azure Event Hubs, GCP Pub/Sub |
| **Object storage** | S3-compatible (AWS S3, MinIO, Azure Blob) — for backup, bulk export, data lake ingestion |
| **Messaging** | MQTT bridge (to external broker), Apache Kafka, AMQP |
| **Enterprise** | SQL bulk insert (MSSQL already present), REST webhook, generic HTTP POST |
| **ERP** | SAP (IDoc / BAPI / REST), Oracle, custom REST/SOAP |

Historian connectivity is a competitive moat. Customers who already have AVEVA PI or Cognite will evaluate FORGE on whether it can feed their existing historian without a separate middleware layer.

### 8.2 Sink configuration model

Each sink is configured as an **outbound connector** with:
- **Source filter:** Which tags, assets, or asset classes to include. Expressed as a topic pattern (e.g., `forge/north-plant/line-3/+/+/temp`) or asset-class selector.
- **Transform:** Optional field mapping, unit conversion, or format adaptation (e.g., rename `inlet_temp` to `TI-301` for PI compatibility).
- **Delivery trigger:** Continuous stream, on-change, on-schedule (cron), or event-triggered.
- **Quality filter:** Only forward `GOOD` quality tags? Or forward all with quality annotation? Configurable per sink.
- **Backpressure:** Rate limit on delivery to the sink (default 1,000 tags/second). Critical for ERP systems that cannot handle burst writes.

### 8.3 Bidirectionality

Every sink connector must support both directions:
- **Outbound:** Tag values flow from FORGE to the destination.
- **Inbound:** The destination sends commands, work orders, or setpoint updates back to FORGE, which routes them through the driver writeback interface to the asset.

An ERP sink that can push work order completions back into FORGE closes the operational loop. A historian sink that accepts setpoint change commands from FORGE enables closed-loop optimization. Read-only sinks are a half-integration.

### 8.4 Sink health and audit

- Every sink connector surfaces its health in the integration health panel: status, last successful delivery, error rate, queue depth.
- Every outbound write — a tag value sent to a historian, a record pushed to an ERP system — is logged in the audit log with: sink ID, tag ID, value, timestamp, delivery status.
- Failed deliveries do not result in silent data loss. They enter the dead-letter queue with the reason for failure, visible in the integration console.

---

## 9. Unified Namespace and i3X

### 9.1 The UNS is the enterprise semantic layer

FORGE's UNS is not just a browser screen — it is the authoritative cross-asset, cross-site namespace that gives every tag in the system a globally resolvable address. Every tag, once ingested and associated with an asset, is automatically emitted into the UNS at its canonical path:

```
{enterprise}/{site}/{area}/{line}/{cell}/{asset}/{signal}
forge/atlas-industrial/north-plant/line-a/cell-3/hx-01/inlet-temp
```

Every node in the UNS carries all its alternate addresses (MQTT topic, OPC UA node ID, FORGE asset ID, i3X elementId, historian tag name) so the same signal is resolvable by any consuming system without a separate mapping step.

### 9.2 Sparkplug B

The MQTT integration must produce and consume **Sparkplug B** encoded payloads. Sparkplug B provides:
- Birth certificates (full metric type and unit definitions on connect).
- Death certificates (disconnect notification via MQTT last-will).
- Sequence numbers (detect message loss without a separate health-check protocol).
- Typed metrics (native Sparkplug type system aligns with the Tag data model).

Raw JSON MQTT topics are supported but Sparkplug B is the production standard. The MQTT integration console must let the operator select the payload encoding per topic pattern.

### 9.3 i3X commitment

The in-process i3X engine (`src/core/i3x/server.js`) implements the CESMII i3X 1.0-Beta OpenAPI surface. This is a significant differentiator — FORGE can interoperate with any CESMII-compliant system out of the box.

The commitment this creates:
- `src/core/i3x/client.js` must remain a thin, swappable HTTP adapter. When a production i3X server is configured, the client switches to external HTTP fetches without any UI changes.
- Business logic must never live inside the i3X client.
- FORGE tracks new i3X spec versions with a documented compatibility matrix.

### 9.4 Schema and data-model registry

The UNS is not just a topic stream — it carries structure. Every UNS node has an associated schema: signal type, unit, engineering range, alarm thresholds, and relationships to other nodes. This registry is queryable via the REST API and browsable in the UNS screen. It is the authoritative source for what a signal means, not just what its current value is.

---

## 10. Collaboration Layer

This is what differentiates FORGE from every other industrial data platform. The collaboration layer is built on top of the data foundation and must remain architecturally coupled to it — not as a separate product bolted on, but as the natural action surface for the data FORGE exposes.

### 10.1 The asset as the convergence point

Every feature in the collaboration layer is anchored to an asset node:
- **Work items** are opened against an asset (or a line or area).
- **Documents** (datasheets, procedures, P&IDs) are linked to assets.
- **Drawings** reference assets by their IDs — markup pins on a P&ID link back to the live asset detail.
- **Incidents** are created on an asset (manually or automatically by alert rules).
- **Approvals** on document revisions are scoped to the asset's engineering team.
- **AI context** in the war room and AI workspace is automatically populated from the incident's linked asset: recent signal history, open work items, linked procedures, past incidents.

This convergence is what makes FORGE more than Litmus + Confluence + Jira. The data and the collaboration are in the same namespace, pointing at the same assets, queryable together.

### 10.2 Document and drawing integrity

Documents and drawings are engineering artifacts with lifecycle requirements that exceed what a general-purpose document system provides:
- **Immutable revisions:** A published revision is never edited in place. A new revision is created, reviewed, and promoted via the approval flow. The previous revision remains accessible forever.
- **Approval signatures are audited:** Every sign/reject action is written to the audit log with the actor, role, timestamp, and any attached note. The signature trail is exportable for compliance.
- **Drawings carry live markup:** Markup pins on an SVG drawing reference real FORGE objects (assets, work items, incidents) by ID — not by label. If an asset is renamed, the pin still points to it.
- **CAD viewers (DXF, IFC, 3D):** Already implemented via `dxf-viewer`, `web-ifc`, `online-3d-viewer`. These must integrate with the asset model — clicking on a component in the 3D view should navigate to the asset detail page.

### 10.3 Work items and Kanban board

The work board is the operational action surface. Work items must be:
- Linked to assets (and therefore inherit signal context and incident links).
- Associated with a driver or integration if the work involves connection changes.
- Exportable to ERP work order systems via the ERP sink (see §8).
- Tracked with SLA timers visible in the operations dock.

### 10.4 Incident war room

The war room is the convergence point for everything that signals a problem exists:
- Alert rules create incidents automatically (see §11).
- Integration connector failures create incidents automatically.
- Incidents are linked to an asset and have access to its full context: live VQT history, open work items, linked documents, past incidents.
- AI next-step recommendations in the war room are scoped to the incident asset's context and must cite sources (documents, procedures, past incidents) rather than hallucinating.
- The incident timeline is append-only. Log entries are never edited.

---

## 11. Alerting, Alarms, and Incidents

Alert rules are a data-plane feature, not a collaboration feature. They run continuously against the tag stream, not against the UI state.

### 11.1 Alert rule engine

Rules are evaluated by the broker subscriber process on every incoming tag event (not on a polling interval). Supported conditions:

| Condition type | Example |
|----------------|---------|
| Threshold | `value > 85` (with optional duration: "for 30 seconds") |
| Rate of change | `d(value)/dt > 2.0 per second` |
| Quality change | `quality changed to BAD` |
| Deadband | `abs(value - setpoint) > tolerance` |
| Sustained condition | `quality == UNCERTAIN for 5 minutes` |
| Connectivity | `driver.status == DISCONNECTED for 2 minutes` |
| Boolean combination | `condition_A AND (condition_B OR condition_C)` |

Rule actions: create incident, send notification (email, SMS, Slack/Teams webhook, MQTT alarm topic), trigger a flow, write a tag (setpoint adjustment), call a webhook.

### 11.2 ISA-18.2 alarm lifecycle

All incidents follow the ISA-18.2 state machine:
```
ACTIVE_UNACKNOWLEDGED → ACTIVE_ACKNOWLEDGED → CLEARED
```
Each transition requires: actor, timestamp, mandatory note for acknowledgment and clearing.

**Shelving:** Suppress an alarm for a defined period (operator confirms reason and duration). Shelved alarms remain visible in a dedicated view. Shelving is audited.

**Alarm flood protection:** If N incidents are created within a time window (configurable, default: 10 incidents in 60 seconds), FORGE enters flood mode — individual incidents are grouped into a flood summary incident. This prevents the operator from being overwhelmed and is required by ISA-18.2.

### 11.3 Alarm historian

All alarm events (creation, state change, acknowledgment, clearing, shelving) are written to the InfluxDB time-series store alongside process data. This is required for post-incident investigation and regulatory compliance. The war room timeline reads from this historian, not from a transient in-memory log.

---

## 12. Offline-First and Resilience

### 12.1 The principle

FORGE must continue functioning — reading, navigating, and displaying data — when connectivity to external systems is lost. The broker, the processing engine, the alert rules, and the local data store all run locally. The cloud and any external historian are destinations, never dependencies.

### 12.2 Offline capability tiers

| Tier | Capability | Mechanism |
|------|------------|-----------|
| **Full local operation** | Drivers collecting, broker routing, alerts firing, InfluxDB writing, collaboration layer fully functional | Everything runs on-box; no external dependency required |
| **Northbound outage** | Sinks buffer locally; replay on reconnect | Broker disk persistence + dead-letter queue |
| **Server unreachable (browser)** | UI shows cached data with staleness indicator; no blank screens | `dexie` IndexedDB + service worker (`sw.js`) |
| **Offline write queue** | User actions (work items, notes, approvals) queued locally, replayed on reconnect | `dexie` offline queue |

### 12.3 Offline write queue requirements

- Persistent across page reloads (IndexedDB via `dexie`).
- Ordered: operations replay in creation order. Out-of-order replay risks data integrity.
- Visible: users see the queue in a panel — what is pending, when it was queued.
- Conflict resolution: if a server-side record was changed while the client was offline, the conflict is surfaced to the user for manual resolution. No silent last-write-wins.

### 12.4 The Reset function

The header "Reset" function restores seed data. In production mode (`NODE_ENV=production`), this must be disabled unless `ALLOW_RESET=true` is explicitly set. A production reset wipes operational data — this must never be accidentally available.

---

## 13. Time and Timestamp Integrity

### 13.1 Two timestamps, always

Every tag carries two timestamps and they must never be conflated:
- **`source_timestamp`:** Time the reading was observed at the source device. Authoritative for data ordering, sequence-of-events analysis, and historian storage.
- **`server_timestamp`:** Time FORGE's driver received the reading. Used only for lag monitoring and integration health metrics.

The UI always displays `source_timestamp` as the primary time. `server_timestamp` is a diagnostic field.

### 13.2 When source time is unavailable

If a device has no clock (many Modbus devices do not), the driver must:
1. Record `source_timestamp` as absent.
2. Set quality to `UNCERTAIN`.
3. Record `server_timestamp` as the best available approximation.

The driver must never silently substitute `server_timestamp` for `source_timestamp`. A tag that shows `GOOD` quality with a wrong timestamp is more dangerous than a tag with `UNCERTAIN` quality and an honest timestamp.

### 13.3 Time synchronization

FORGE must keep its own system clock synchronized:
- **Primary:** NTP (acceptable for most use cases, 1–50 ms accuracy).
- **High-accuracy option:** IEEE 1588v2 PTP via `ptpd` or `ptp4l` — for sites running sequence-of-events analysis or fast control loops where ms-level accuracy is required.
- The health dashboard surfaces current time source, stratum, and estimated drift.
- When time sync is lost, all new tag readings are emitted with quality `UNCERTAIN` and a platform alarm is created.

### 13.4 Time zones

All timestamps stored in UTC. Display conversion to the user's local time zone or a configured site time zone happens at render time only. Mixing UTC and local times in the database is a category of bug that compounds silently over years.

---

## 14. Observability and Self-Monitoring

FORGE already has `prom-client` and OpenTelemetry integrated. The patterns here define what to measure.

### 14.1 Required Prometheus metrics

| Metric | Type | Labels |
|--------|------|--------|
| `forge_tags_ingested_total` | Counter | `driver_id`, `quality` |
| `forge_tags_per_second` | Gauge | `driver_id` |
| `forge_driver_status` | Gauge (1=connected) | `driver_id`, `protocol` |
| `forge_driver_poll_latency_seconds` | Histogram | `driver_id` |
| `forge_broker_queue_depth` | Gauge | `topic_prefix` |
| `forge_sink_delivered_total` | Counter | `sink_id`, `sink_type` |
| `forge_sink_errors_total` | Counter | `sink_id`, `error_code` |
| `forge_sink_lag_seconds` | Histogram | `sink_id` |
| `forge_opcua_sessions_active` | Gauge | — |
| `forge_flow_executions_total` | Counter | `flow_id` |
| `forge_flow_errors_total` | Counter | `flow_id` |
| `forge_alert_rules_fired_total` | Counter | `severity` |
| `forge_active_incidents_total` | Gauge | `severity` |
| `forge_api_request_duration_seconds` | Histogram | `route`, `method`, `status` |
| `forge_db_query_duration_seconds` | Histogram | `query_name` |
| `forge_influxdb_write_latency_seconds` | Histogram | — |
| `forge_offline_queue_depth` | Gauge | — |

### 14.2 Health endpoint

`GET /api/health` returns structured system health:
```json
{
  "status": "ok | degraded | starting",
  "version": "0.3.0",
  "uptime_seconds": 86400,
  "subsystems": {
    "database": "ok",
    "broker": "ok",
    "influxdb": "ok",
    "drivers": { "modbus-01": "connected", "opcua-02": "degraded" },
    "sinks": { "pi-historian": "ok", "erp-sap": "disconnected" },
    "time_sync": { "source": "ntp", "stratum": 2, "drift_ms": 12 }
  }
}
```

### 14.3 Structured logging

All server-side logging via `pino` (already present). Every log line must carry structured fields — no free-form string concatenation. Log levels configurable per subsystem via environment variable, without restart. Forward-compatible with Loki, Elasticsearch, or Splunk via the log forwarder integration.

### 14.4 OpenTelemetry traces

The existing OpenTelemetry setup must trace the full path of a tag from driver → broker → flow engine → InfluxDB write → OPC UA server response. This trace is the primary tool for diagnosing "why is this value stale?" or "why is this API slow?" before a production incident.

---

## 15. Security Architecture

### 15.1 Network transport

- TLS 1.2+ for all network communication — broker (MQTT over TLS), OPC UA (security mode SignAndEncrypt), REST/GraphQL API (HTTPS), WebSocket connections.
- The internal broker (driver-to-broker) uses mTLS or credentials generated at startup. Never exposed without authentication.
- The external-facing broker endpoint (§7.2) has its own certificate and per-client ACLs.
- FORGE must operate correctly within a Purdue Model zone architecture — southbound to OT devices (Levels 0–2), northbound to enterprise systems (Levels 4–5), never bridging them without inspection at the FORGE layer.

### 15.2 Authentication and authorization

- `@fastify/jwt` for session tokens. Short expiry: 15-minute access tokens, 7-day refresh tokens. Silent token refresh in the client.
- `bcryptjs` for local account password hashing.
- SSO via SAML 2.0 / OIDC — primary enterprise path. Local accounts are fallback only.
- API keys for machine-to-machine: scoped (read / write / admin), rotatable, expirable, stored as hashes.
- RBAC enforced server-side on every route. The UI hiding a button is UX; the server rejecting the API call is security. Both required.
- Per-flow RBAC: who can view, edit, enable, disable, and debug each flow.
- Write operations to devices (tag writeback, OPC UA write, MQTT command publish) are gated by a separate `CAN_WRITE_DEVICE` capability, not just general write permission. This is the highest-risk operation in the system.

### 15.3 Integration credential security

No integration credentials (MQTT passwords, OPC UA certificates, database connection strings, ERP API keys) are stored in plaintext in SQLite or in `.env` files checked into version control.

Required:
- In development: `.env` (gitignored) — `.env.example` shows required keys without values (already in repo).
- In production: environment variables injected at runtime, or a secrets manager sidecar (Vault, AWS Secrets Manager, Azure Key Vault).
- Credential fields in the UI are **write-only**: they can be set or updated, but any GET response that includes integration config must redact all credential values.

### 15.4 Audit log integrity

The audit log is append-only. No API endpoint may update or delete audit log entries. It must be:
- In its own SQLite table, separate from operational tables.
- Exportable in full without requiring direct database access (compliance export via `GET /api/v1/audit?from=&to=`).
- Retained indefinitely by default, with a configurable archival policy (not deletion).

Every device write, every configuration change, every approval, every role assignment, every login event, every API key creation — all in the audit log with actor, timestamp, and before/after values.

### 15.5 Supply chain

- `npm run sbom` (via `@cyclonedx/cyclonedx-npm`) runs at every release. `bom.json` published with release artifacts.
- `npm run audit:prod` passes (no high-severity CVEs in production deps) as a required release gate.
- `npm run release:check` is the mandatory pre-merge gate.
- `.gitleaks.toml` (already in repo) must be enforced in CI — no secrets in commit history.

---

## 16. Configuration as Code

Every configurable aspect of FORGE must be exportable as a version-controllable file. "Config in the UI only" is a trap that makes sites impossible to audit, replicate, or recover.

### 16.1 Exportable configuration

| Configuration | Export endpoint |
|---------------|-----------------|
| Driver definitions (protocol, connection, tag list) | `GET /api/v1/config/drivers` |
| Integration sinks | `GET /api/v1/config/sinks` |
| Signal/tag mappings | `GET /api/v1/config/mappings` |
| Asset class schemas | `GET /api/v1/config/asset-classes` |
| Flow definitions | `GET /api/v1/config/flows` |
| Alert rules | `GET /api/v1/config/alert-rules` |
| RBAC role definitions | `GET /api/v1/config/roles` |
| UNS namespace definitions | `GET /api/v1/config/uns` |
| OPC UA server config | `GET /api/v1/config/opcua-server` |

### 16.2 Import and reconcile

`POST /api/v1/config/{type}` accepts the same files for import. Import is **idempotent** — applying the same config twice has the same result as once. This enables GitOps workflows.

Configuration changes applied via import appear in the audit log with actor `system.config-import` and the file hash.

### 16.3 Recommended GitOps workflow

```
Git repository (config as source of truth)
    ↓ PR review + merge
CI validates config schema (npm run typecheck)
    ↓ pass
Config import to staging FORGE instance
    ↓ health check pass
Promote to production FORGE instance
```

---

## 17. REST and GraphQL API Design

### 17.1 Principles

- **The UI is a client.** Every operation in the web UI goes through the same REST/GraphQL endpoints available to external callers. No privileged internal channels.
- **Consistent envelope.** All REST responses: `{ "data": ..., "meta": {...}, "errors": [...] }`. All errors carry machine-readable `code` fields.
- **URL-versioned.** `/api/v1/`, `/api/v2/`. Old versions supported minimum 12 months after new major version ships.
- **OpenAPI 3.0 spec** published and kept current. RapiDoc (already present) renders it at `/api/docs`.

### 17.2 Key REST endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/v1/assets` | Browse asset hierarchy |
| `GET` | `/api/v1/assets/{id}/tags` | All tags for an asset |
| `GET` | `/api/v1/tags/{id}/value` | Latest VQT for a tag |
| `GET` | `/api/v1/tags/{id}/history` | Time-series from InfluxDB (`?from=&to=&resolution=`) |
| `POST` | `/api/v1/tags/{id}/write` | Write value to device (audited, role-gated) |
| `GET` | `/api/v1/drivers` | List driver instances and status |
| `POST` | `/api/v1/drivers/{id}/restart` | Restart a driver |
| `GET` | `/api/v1/sinks` | List outbound sink connectors and health |
| `GET` | `/api/v1/flows` | List flow definitions |
| `POST` | `/api/v1/flows/{id}/enable` | Enable/disable a flow |
| `GET` | `/api/v1/incidents` | Active and historical incidents |
| `GET` | `/api/v1/audit` | Audit log export |
| `GET` | `/api/health` | Structured health check |
| `GET` | `/metrics` | Prometheus metrics |

### 17.3 GraphQL subscriptions

The GraphQL API (via `mercurius`) must support subscriptions for real-time tag data:
```graphql
subscription {
  tagUpdated(assetId: "hx-01") {
    id value quality sourceTimestamp unit
  }
}
```
Subscriptions are backed by broker topic subscriptions on the server — the GraphQL layer is a thin bridge, not a polling loop.

### 17.4 Webhooks

Outbound webhooks for: incident created/resolved, approval required/completed, driver status changed, sink health changed. Webhook delivery is retried with exponential backoff and logged in the audit log.

---

## 18. Schema Evolution and Compatibility

- **Field additions** are backward-compatible. Clients must ignore unknown fields.
- **Field removals** require a deprecation notice and one major API version of deprecation period.
- **Type changes** are breaking — require a new major API version.
- **Driver contract versions** are explicitly negotiated at driver load time. FORGE refuses to load a driver whose contract version it cannot satisfy.
- **Database migrations** (`server/db.js --migrate-only`) are additive by default, idempotent, and logged.
- **Event schema changes** are backward-compatible within a minor version. Consumers handle both schemas during transitions.

---

## 19. Performance Targets

Design targets, validated before each release. Reference hardware: 8-core CPU, 16 GB RAM, SSD.

| Metric | Target | Notes |
|--------|--------|-------|
| Tag ingest throughput | ≥ 50,000 tags/second | Sustained; broker → InfluxDB write path |
| End-to-end latency (driver → broker → InfluxDB) | ≤ 100 ms p99 | Under nominal load |
| OPC UA read latency (monitored item) | ≤ 50 ms p95 | From tag update to OPC UA client notification |
| REST API response (read endpoints) | ≤ 200 ms p95 | Excludes external historian queries |
| REST API response (write endpoints) | ≤ 500 ms p95 | Includes audit log write |
| Flow engine throughput | ≥ 10,000 messages/second per flow | Per flow instance |
| Alert rule evaluation lag | ≤ 500 ms | From tag event to incident creation |
| UNS browser render (10,000 nodes) | ≤ 2 seconds | Initial load |
| Offline mode load (no server) | ≤ 3 seconds | Hard reload to usable screen |
| Max configured tags per instance | ≥ 500,000 | Only actively-polled tags count against throughput |
| Concurrent web users | ≥ 50 | Single Fastify process |
| Cold start (all services ready) | ≤ 60 seconds | Broker + drivers + Fastify + InfluxDB connection |

---

## 20. Deployment Models

| Model | Use case | Notes |
|-------|----------|-------|
| **Docker Compose** | Primary self-hosted deployment | `docker-compose.yml` already ships Fastify + Mosquitto. Add InfluxDB service. |
| **Bare-metal / VM** | Plant floor servers, air-gapped sites | `npm start` on Node.js 20+. Mosquitto and InfluxDB installed separately. |
| **Client-only demo** | UX evaluation, sales demos | `python3 -m http.server` — falls back to in-process demo mode automatically. |
| **Kubernetes / Helm** | Multi-instance, HA production | Helm chart to be added. SQLite → PostgreSQL migration required for shared state. StatefulSets for InfluxDB. |

**Air-gap support is required.** Installation, license activation, driver updates, and software updates must all be doable with zero internet egress. This means:
- All npm dependencies bundled in the release archive (no `npm install` at deployment time on the target machine).
- Offline license activation path (signed token, activated locally).
- Driver updates delivered as signed archives, verified before installation.

---

## 21. Design Philosophy

These principles must be applied to every significant decision in the FORGE repo. If a proposal conflicts with a principle, name the conflict explicitly.

1. **The broker is the backbone.** Every internal interaction flows through the normalizing message bus. No module talks to a driver directly. No module bypasses the broker to push data to another module.

2. **Tags are universal.** One atomic data type — the Tag — flows through every layer: from driver to broker to processing to storage to server roles to collaboration UI. No module downstream of a driver ever sees a raw protocol frame.

3. **Drivers are a plugin contract, not a hard-coded list.** The contract is the product. A public SDK that lets customers and partners write their own drivers is worth more than 250 built-in drivers with no SDK.

4. **Serve as many as you connect.** FORGE is a server, not just a client. Every system that sends data to FORGE must be able to receive data from FORGE — via OPC UA, MQTT, REST, GraphQL, or a configured sink.

5. **Data and collaboration live in the same namespace.** The asset hierarchy is the universal organizing structure. Tags, documents, work items, incidents, and drawings all belong to assets. This convergence is what differentiates FORGE from a data platform + a separate collaboration tool.

6. **Offline-first, cloud-optional.** The broker, the alert engine, the driver processes, and the collaboration layer all run locally. Cloud connectivity is for northbound sinks and remote access — never a prerequisite for local operation.

7. **Quality is consumed, not ignored.** BAD and UNCERTAIN quality tags must be visually and semantically distinct from GOOD quality at every display surface and every northbound sink. Silently forwarding bad data is worse than not forwarding it.

8. **The audit log is inviolable.** Every state change is recorded. The audit log is append-only and cannot be deleted through normal operation. Compliance is a property of the system, not a report generated retroactively.

9. **Configuration is code.** Every driver, mapping, flow, alert rule, and role definition is a file that can be version-controlled, reviewed, and applied via the API. Nothing exists only in the UI.

10. **Security is a constraint, not a feature.** TLS everywhere, RBAC on every route, credential storage without plaintext, device write authorization as a separate capability — these are baseline, not additions.

11. **Low-code by default, code as escape hatch.** The buyer is an OT/controls engineer. The visual flow engine, the mapping UI, and the alert rule builder must not require writing code for the common case.

---

## 22. Anti-Patterns

| Anti-pattern | Why it's fatal |
|---|---|
| A module communicates with a driver directly, bypassing the broker | The protocol abstraction collapses; every module now has to understand every protocol; adding a new driver requires changing every consumer |
| `source_timestamp` silently replaced by `server_timestamp` | Corrupts sequence-of-events analysis; post-incident fault investigation leads to the wrong cause |
| Showing a tag value without its quality indicator | Operators make decisions on BAD or UNCERTAIN data; a downstream incident is the result |
| Write operations to devices not in the audit log | "Who changed the setpoint?" has no answer; compliance audit fails |
| Integration credentials stored in plaintext | One database dump or log file leak exposes every connected system |
| UI-only feature gating without server-side enforcement | RBAC is decorative; any user with browser dev tools can call gated APIs |
| Sink that only pushes (no inbound) | Closes off closed-loop optimization; ERP can't push work orders back; historian can't accept setpoint commands |
| Alert rules evaluated in the browser or on a polling interval | Alarms miss events between polls; alarms stop firing when no browser is open; polling introduces latency |
| Mutable tag state ("current value" updated in place) | Destroys historical record; sparklines break; sequence-of-events analysis is impossible |
| Collaboration features that don't reference assets | Disconnects collaboration from data; a work item with no asset link cannot display signal context or auto-populate the war room |
| The Reset button available in production | Operational data loss; any user with the role can wipe the instance |
| Air-gap assumption violated at install time | Eliminates every plant-floor and offshore deployment; these are the highest-value customers |

---

## 23. Out of Scope for v1

| Capability | Rationale | Integration path |
|------------|-----------|-----------------|
| **PLC programming** | Requires vendor engineering software (TIA Portal, Studio 5000), HMI-grade safety tooling, and deep protocol write support beyond what an integration platform provides | FORGE reads and writes setpoints via OPC UA/Modbus; it does not replace PLC IDEs |
| **SCADA / HMI replacement** | HMI graphics, IEC 61511 alarm rationalization, and functional safety are a different product | FORGE interoperates as an OPC UA server that SCADA clients poll |
| **ML model training** | Training infrastructure is cloud-native and requires GPU resources | FORGE runs inference on pre-trained ONNX/TFLite models; training stays in the cloud |
| **Full digital twin physics simulation** | Physics-based simulation and design-time twin management are PLM-level concerns | FORGE's asset model is the structural foundation a DT platform can build on top of |
| **Full ERP transaction processing** | Bidirectional ERP with full transaction semantics (multi-step sagas, rollback, reconciliation) is a dedicated integration product | ERP sink handles targeted writes: work order status, QC results, production counts |
| **General BI platform** | FORGE hosts BI containers (Grafana) and exposes data via API; building a BI query engine is a different product | Expose data via REST, GraphQL, InfluxDB, OPC UA; let existing BI tools consume it |

---

## 24. Success Criteria

The specification has been successfully internalized when all of the following are demonstrably true in a running FORGE instance:

| Criterion | Measurable target |
|-----------|-------------------|
| Protocol-agnostic consumption | The same tag value from a Modbus register is simultaneously available via MQTT topic, OPC UA monitored item, REST API, and GraphQL subscription — with identical VQT values and timestamps |
| Device onboarding time | An OT engineer with no prior FORGE training adds a Modbus TCP device and imports its tags in ≤ 10 minutes, with zero lines of code written |
| Offline local operation | FORGE runs for 30+ days with no internet connectivity and no external historian, with full driver ingest, alert rules firing, and collaboration layer fully functional |
| Northbound delivery integrity | A 72-hour northbound outage followed by reconnection results in all buffered tag data being delivered to the sink in chronological order, with original source timestamps, and all delivery events in the audit log |
| Bidirectional integration | A value written from the FORGE UI to an OPC UA node is traceable in the audit log with actor, timestamp, target node, and value |
| Quality enforcement | Every tag value displayed in the UI — sparklines, KPI cards, UNS browser, asset detail, flow debug mode — also shows quality; BAD quality is visually distinct from GOOD |
| Config as code | All driver definitions, mappings, flows, and alert rules can be exported as files, committed to a repo, and applied to a fresh FORGE instance to reproduce the exact same running configuration |
| Audit completeness | A compliance audit finds no device write, configuration change, approval, or login event that does not have a corresponding immutable audit log entry |
| Driver SDK usability | An external developer writes a working protocol driver using only the published SDK and documentation in ≤ 8 working hours |
| Performance floor | 50,000 tags/second sustained ingest with ≤ 100 ms p99 end-to-end latency, 50 concurrent web users, ≤ 200 ms p95 API response time — all simultaneously on reference hardware |

---

## 25. Glossary

| Term | Definition |
|------|------------|
| **Asset** | A physical or logical entity in the industrial hierarchy (pump, motor, line, site). The primary organizing unit in FORGE — tags, documents, work items, incidents, and drawings all belong to assets. |
| **Asset class** | A template defining the expected signals, documents, and KPIs for assets of a given type. Instances inherit the class schema. |
| **Audit log** | An append-only record of every state-changing operation: mutations, device writes, approvals, login events, configuration changes. Cannot be deleted via normal operation. |
| **Birth/death certificate** | Sparkplug B mechanism. A device publishes a birth certificate (full metric type and unit definitions) on connect and a death certificate (via MQTT last-will) on disconnect. Required for Sparkplug B compatibility. |
| **Broker spine** | The internal MQTT broker through which all driver data flows before reaching any other module. The normalizing hub of the entire data plane. |
| **CESMII i3X** | The Smart Manufacturing API standard for querying typed industrial object graphs with VQT readings. FORGE implements the i3X 1.0-Beta OpenAPI surface. |
| **Dead-letter queue** | A queue for messages that failed delivery after repeated retries. Visible in the integration health panel for operator inspection rather than silent discard. |
| **Driver** | A plugin that implements a protocol-specific adapter, translating native device data into Tags and publishing them to the broker. Never communicates with downstream modules directly. |
| **Flow engine** | The visual, low-code data processing layer. Drag-and-drop canvas where OT engineers build processing, routing, and transformation logic without writing code. Node-RED is the reference implementation. |
| **IEC 62443** | Industrial cybersecurity standard suite. The security baseline for OT environments. |
| **ISA-18.2** | ISA standard for industrial alarm management. Defines alarm lifecycle states, shelving, flood protection, and documentation requirements. |
| **ISA-95** | International standard defining the enterprise-control hierarchy (Enterprise/Site/Area/Line/Cell/Asset) and manufacturing data models. FORGE's asset hierarchy uses this as the default template. |
| **Last-will/testament (LWT)** | An MQTT feature where a client pre-registers a message to be published by the broker if the client disconnects unexpectedly. Used by drivers to emit a quality-degraded tag on crash. |
| **Modbus** | A serial communication protocol (1979, Modicon). The most widely deployed industrial protocol. Two variants: Modbus RTU (serial RS-485), Modbus TCP (Ethernet). `modbus-serial` implements both. |
| **MQTT** | Message Queuing Telemetry Transport. The primary pub/sub protocol for industrial IoT. The broker spine, external MQTT server, and UNS all use MQTT. |
| **NanoMQ** | A lightweight MQTT broker suitable for embedded/resource-constrained deployments. Alternative to Mosquitto on low-power hardware. |
| **Northbound** | The direction from FORGE toward enterprise systems (ERP, historians, cloud platforms). Includes both server roles (pull model) and data sinks (push model). |
| **OEE** | Overall Equipment Effectiveness = Availability × Performance × Quality. The primary manufacturing productivity KPI. |
| **OPC UA** | OPC Unified Architecture. The preferred modern machine-to-machine protocol. FORGE implements both OPC UA client (driver) and OPC UA server (northbound server role). |
| **Purdue Model** | A hierarchical model of industrial control system architecture (Levels 0–5) used as a security segmentation reference. FORGE operates at Level 3/3.5. |
| **QoS** | Quality of Service. MQTT delivery guarantee levels: 0 (at most once), 1 (at least once), 2 (exactly once). Tag data uses QoS 1; device commands use QoS 2. |
| **Sink** | An outbound data connector that pushes FORGE tag data to an external system (historian, ERP, cloud platform, object storage). All sinks are bidirectional by default. |
| **Southbound** | The direction from FORGE toward field devices (PLCs, sensors, actuators). Implemented by protocol drivers. |
| **Sparkplug B** | An MQTT topic namespace and payload specification (Eclipse Foundation) that adds birth/death certificates, sequence numbers, and typed metrics to MQTT. The production payload standard. |
| **Store-and-forward** | The capability to buffer outbound data locally when a northbound sink is unavailable and replay it in order, with original timestamps, when the connection is restored. |
| **Tag** | The atomic, immutable data unit. Every driver output, every processed value, every sensor reading is a Tag: typed value + quality + source timestamp + server timestamp + unit + identity. |
| **UNS** | Unified Namespace. A cross-asset, cross-site hierarchical namespace where every tag is addressable by a canonical path, MQTT topic, OPC UA node ID, and i3X elementId simultaneously. |
| **VQT** | Value / Quality / Timestamp. The three core fields of every industrial signal reading. FORGE extends this with unit, data_type, source_ref, and asset_ref to form a complete Tag. |
| **War room** | FORGE's incident management screen. The convergence point for live signals, AI recommendations, chronological timeline, commander assignment, and linked asset context. |

---

*End of specification.*
