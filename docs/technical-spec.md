# OpenCodingPartner: SOTA Technical Specification & Master Architecture Plan

## Executive Overview
This document represents the long-term technical blueprint for **OpenCodingPartner (OCP)**. It synthesizes the codebase review, state-of-the-art methods for codebase graph intelligence, end-to-end agent observability, minimalist UI design, multi-agent parallel swarms, cross-platform compatibility, packaging, and cloud scalability.

---

## 1. Codebase Architecture & Current State Review

### 1.1 Package Topology
```
packages/
├── mesh/       # Domain contracts, session bindings (agent:board:main), agent roles
├── policy/     # Route classifier, command rules, and security policies
├── workers/    # Guarded filesystem tools, secret scanner (securityGate), Playwright driver
├── swarm/      # In-memory role registry and agent dispatch
├── gateway/    # Turn coordination, Slack/Telegram delivery, routines, fleet, SDLC handoffs
├── bundle/     # Legacy toolchain discovery (OpenClaw, Laya, Grok stdio, LiteLLM)
├── product/    # Product core: JSON storage (bots.json, tasks.json), ACP runtime adapter, 
│               # workspace MCP server (workspace-mcp.ts), virtual desktop, vault, server.ts
└── cli/        # CLI entry point (ocp app, ocp bot, ocp task, ocp prove, ocp doctor)
```

### 1.2 Identified Strengths
- **Guarded Filesystem MCP Server (`workspace-mcp.ts`)**: 500 KB read/write bounds, path-traversal rejection, `.ocp/` / `gtm/` path protections, and automatic secret-pattern masking (`securityGate`).
- **Durable Bot & Task Persistence**: Persistent JSON state survives process restarts; tasks track baseline diffs, approval history, and process recovery IDs.
- **Virtual Computer with "Take Control" (`computer-desktop.ts`)**: Seamless desktop screen capture, mouse and keyboard injection, and human takeover flow for captchas and 2FA.
- **Vault Challenge System (`vault.ts`)**: Credentials stored securely; model never sees plain text.
- **Routines & Skills**: Cron schedules, inbound webhooks, and reusable tool bundles.

### 1.3 Identified Bottlenecks & Tech Debt
- **Monolithic UI (`server.ts`)**: A single 273 KB (4,358-line) file generates inlined HTML/CSS/JS strings without HMR, modular testing, or type-safe DOM components.
- **Cognitive Density**: The current 3-column studio displays 15 tabs across 6 groups at all times.
- **Lack of Codebase Indexing**: Filesystem exploration relies on naive `grep` and `glob` rather than AST symbol-graphs and dependency trees.
- **1-Hop Sequential Handoffs**: Task collaboration is currently restricted to linear single-turn transitions (`coder` -> `reviewer`) rather than dynamic multi-agent DAGs.

---

## 2. Codebase Graph Intelligence (AST, SCIP & RepoMap)

### 2.1 The Problem with Naive Context
Grepping code and dumping full files into the model context window wastes token budgets, slows inference, and frequently misses cross-file dependency breaks.

### 2.2 SOTA Method: Code Property Graph (CPG)
- **Concrete Syntax Trees via Tree-Sitter**: Multi-language parsing (TypeScript, JavaScript, Python, Go, Rust, C/C++) directly in `packages/workers`.
- **Source Code Indexing Protocol (SCIP)**: Standardized semantic indexing capturing definitions, references, and type hierarchies.
- **Local SQLite CPG (`.ocp/graph.sqlite`)**:
  - **Nodes**: Files, Classes, Functions, Interfaces, Types, and HTTP/RPC routes.
  - **Edges**: `calls`, `imported_by`, `inherits_from`, `implements`, `references`, `routes_to`.
- **Incremental Synchronization**: Background file watcher (`chokidar` / native OS events) parsing only dirty files on change.

### 2.3 Personalized PageRank RepoMap (Context Compression)
- Using the symbol graph, compute a **Personalized PageRank** centered on the user's active file or query.
- Compresses the codebase into a dense, token-efficient ASCII/JSON skeleton of relevant method signatures and call paths.
- Context overhead drops by 70–90% while improving reasoning accuracy.

### 2.4 Pre-Edit Blast-Radius & Impact Analysis
Expose new MCP tools to OCP Coder:
- `code_symbol_find(name)`: Locate definitions and signatures.
- `code_get_callers(symbol)` / `code_get_callees(symbol)`: Traverse call graphs.
- `code_blast_radius(path, symbol)`: Determine all downstream files and modules impacted before proposing a diff.

---

## 3. End-to-End Observability Engine (Toggleable)

### 3.1 OpenTelemetry GenAI Semantic Conventions (`gen_ai.*`)
Implement standard telemetry spans:
- `gen_ai.operation.name`: `chat`, `task_plan`, `tool_call`, `subagent_delegate`.
- `gen_ai.request.model`: e.g., `anthropic/claude-3-7-sonnet`, `deepseek-coder`.
- `gen_ai.usage.input_tokens` / `output_tokens`.
- `gen_ai.tool.name` & `gen_ai.tool.arguments`.

### 3.2 Hierarchical Trace Spans & Flamegraphs
```
Root Span: User Task Request [3.8s, $0.014, 4.2k tokens]
├── Task Planner (Ada / Orchestrator) [1.1s]
│   └── Model Inference (OpenRouter) [1.0s]
├── Tool Execution: code_blast_radius [0.08s]
├── Tool Execution: workspace_patch [0.12s]
└── Sub-agent Delegation: Grace (QA Reviewer) [2.4s]
    ├── Model Inference [1.8s]
    └── Tool Execution: workspace_test (node --test) [0.5s]
```
- **Latency Waterfalls & Flamegraphs**: Visually diagnose hanging tools, slow provider responses, or infinite agent retry loops.

### 3.3 Three Toggleable Modes
1. **`OFF` (Zero Overhead)**: Clean production mode; only essential audit rows saved.
2. **`STANDARD` (HUD Metrics)**: Real-time token counter, live dollar cost estimation per model, and tool outcome badges.
3. **`DEEP TRACE` (Inspector & Flamegraph)**: Complete telemetry capture with flamegraph visualization, replayable step timelines, and optional OTLP export to **Langfuse**, **Arize Phoenix**, or **Jaeger**.

---

## 4. Minimalized User Interface (Zero-Clutter Progressive Disclosure)

### 4.1 Frontend Architecture Decoupling
- Extract UI from `packages/product/src/server.ts` into `packages/ui`.
- Technology: **Vite + Vanilla CSS / Tailwind + Lightweight Preact/React**.
- Communication: Typed HTTP REST + Server-Sent Events (SSE) / WebSocket.

### 4.2 Modern Split-Screen Zen Layout
```
┌────────────────────────────────────────────────────────────────────────┐
│  [OCP]  my-project (main*)         [Linus · Coder 🟢]  [Cmd+K] [Theme] │
├───────────────────────────────────┬────────────────────────────────────┤
│  CHAT & GOAL TIMELINE             │  INTERACTIVE DIFF & REVIEW CANVAS  │
│                                   │                                    │
│  User: Add rate-limiting to auth  │  src/auth/limiter.ts               │
│                                   │  ───────────────────               │
│  Linus (OCP Coder):               │  + export function rateLimit() {   │
│  "Blast-radius checked: 2 routes. │  +   return tokenBucket(10, 60);   │
│   Diff ready for review."         │  + }                               │
│                                   │                                    │
│  ┌─ [✓ Read auth.ts (112 lines)]┐ │  [ ✓ Approve ] [ ✗ Reject ]        │
│  └──────────────────────────────┘ │  [ ✎ Edit Inline ]                 │
│                                   │                                    │
│                                   │  ┌──────────────────────────────┐  │
│                                   │  │ Virtual Computer (PiP)       │  │
│                                   │  │ [Live Frame - 1024x768]      │  │
│                                   │  │ [Take Control] [Detach]      │  │
│                                   │  └──────────────────────────────┘  │
├───────────────────────────────────┴────────────────────────────────────┤
│  [✦ Linus ▾]  Describe change, @bot, #file, or /command...             │
└────────────────────────────────────────────────────────────────────────┘
```
- **Zen Mode**: Uncluttered single-column chat when idle; automatically slides open the Diff Canvas when code changes are proposed.
- **Monaco / CodeMirror Diff Canvas**: Syntax-highlighted side-by-side or unified diffs with line-level approval and instant inline editing.
- **Omnibar & Command Palette (`Cmd+K`)**: Replaces the 15-tab drawer with quick fuzzy navigation (`/bot`, `/model`, `/graph`, `/trace`, `/worktree`).
- **PiP Virtual Computer**: Draggable, resizable overlay with instant "Take Control" shortcut.

---

## 5. Git Worktree Sandboxing & Parallel Swarm Execution

### 5.1 Branch & Worktree Isolation Engine
- When a task begins, OCP automatically creates an isolated Git worktree:
  `.ocp/worktrees/<task-id>` branching off `HEAD`.
- Agents inspect and edit files strictly inside this worktree.
- The developer's active working copy remains completely untouched until approval.
- **Time Machine (`Cmd+Z`)**: Discarding a task instantly purges the worktree, leaving zero dirty state.

### 5.2 Dynamic Multi-Agent Task DAGs
Move beyond 1-hop sequential handoffs:
- **Lead Architect**: Decomposes a feature into a Directed Acyclic Graph (DAG) of sub-tasks.
- **Parallel Coder Bots**: Concurrently write frontend and backend implementations in independent worktrees.
- **Parallel Security & QA Bots**: Concurrently execute type-checks, unit tests, and vulnerability scans.
- **Reconciler**: Merges clean worktrees, resolves merge conflicts, and presents a single unified diff for human approval.

---

## 6. Universal Cross-Compatibility Layer

```
                           ┌────────────────────────┐
                           │   OpenCodingPartner    │
                           │   Core Daemon (ocpd)   │
                           │   (Port 4317 / gRPC)   │
                           └───────────┬────────────┘
                                       │
     ┌───────────────────┬─────────────┴─────────────┬───────────────────┐
     ▼                   ▼                           ▼                   ▼
┌──────────────┐   ┌──────────────┐          ┌──────────────┐    ┌──────────────┐
│  Cursor /    │   │  Claude Code │          │ Gemini       │    │ Standalone   │
│  VS Code     │   │  & Terminal  │          │ Antigravity  │    │ Desktop IDE  │
│  Extension   │   │  TUI Mode    │          │ MCP / Sidecar│    │ (Tauri App)  │
└──────────────┘   └──────────────┘          └──────────────┘    └──────────────┘
```

1. **Dual-Mode Model Context Protocol (MCP)**:
   - **Host Mode**: Ingest external MCP servers (e.g., PostgreSQL, Chrome DevTools, GitHub).
   - **Server Mode (`ocp mcp`)**: Expose OCP tools (workspace tools, AST queries, virtual computer, fleet delegation) to Claude Code, Antigravity, or Cursor.
2. **Cursor / VS Code Companion Extension (`vscode-opencodingpartner`)**:
   - In-editor inline generation (`Cmd+K`).
   - Persistent team chat Composer sidebar (`Cmd+L`).
   - One-click native VS Code diff application.
3. **Claude Code-Style Terminal TUI (`ocp tui`)**:
   - Fast, keyboard-driven terminal REPL for CLI power users.
4. **Standalone Desktop IDE (Tauri)**:
   - Ultra-lightweight native desktop app embedding Monaco Editor, terminal, and live Virtual Computer canvas.

---

## 7. Packaging & Long-Term Cloud / Mobile Vision

### 7.1 Multi-Platform Packaging
- **Python `uv` / `pip` Installer**: Run anywhere via `uvx opencodingpartner` or `pip install opencodingpartner`.
- **Native Desktop Installers**: Cross-compiled via **Tauri**:
  - macOS DMG (Universal binary: Apple Silicon + Intel).
  - Windows MSI / EXE (Webview2 backend).

### 7.2 Chargeable Always-On Cloud & Mobile Companion
- **Always-On Cloud Daemon (`ocpd-cloud`)**:
  - Multi-tenant, containerized agent fleets running 24/7 on remote cloud sandboxes.
  - Subscriptions for managed compute, hosted model credits, and persistent workspaces.
- **Mobile Companion Apps (Android & iOS)**:
  - Push notifications when tasks finish or require human approval.
  - Mobile diff reviewer with one-tap "Allow once", "Always", or "Deny".
  - Trigger routines or check agent status on the go.

---

## 8. Master Granular Task Checklist

### Milestone 1: Observability & Telemetry Engine
- [x] **1.1 Telemetry Core & GenAI Conventions** 🟢 *(Sequential)*
  - Created `packages/product/src/telemetry.ts` implementing native OpenTelemetry-compatible tracing with `gen_ai.*` attributes.
  - Span life-cycle hooks for sessions, turns, agent calls, tool calls, and model inference.
- [x] **1.2 Config & UI Toggle Control** ⚡ *(Parallel)*
  - Added `ObservabilityMode` ("off" | "standard" | "deep") with `/api/telemetry/mode` and `/api/telemetry/traces` endpoints.
- [ ] **1.3 Token Metering & Dynamic Cost Calculator** ⚡ *(Parallel)*
  - Enhance `usage.ts` to calculate real-time cumulative cost across LiteLLM, OpenRouter, and local models.
  - Record tokens/sec, latency, and cost per turn.
- [x] **1.4 Local Waterfall & Flamegraph Visualizer Data Structure** ⚡ *(Parallel)*
  - Implemented `toFlamegraph()` generating hierarchical tree nodes of nested span latencies, tool arguments, and return payloads.
- [ ] **1.5 OTLP Exporter Bridge** ⚡ *(Parallel)*
  - Add optional OTLP/HTTP export to send traces to local/remote Langfuse or Jaeger instances.

### Milestone 2: Codebase Graph Intelligence (AST, SCIP & RepoMap)
- [x] **2.1 Multi-Language Symbol Extractor (AST/CST)** 🟢 *(Sequential)*
  - Implemented `extractTypeScriptSymbols` in `packages/workers/src/code-graph.ts` for functions, classes, interfaces, types, and routes.
- [x] **2.2 Code Property Graph (CPG) Core** 🟢 *(Sequential)*
  - Implemented `CodePropertyGraph` storing nodes and call edges with real-time graph updates.
- [x] **2.3 PageRank "RepoMap" Context Pruner** ⚡ *(Parallel)*
  - Implemented `generateRepoMap()` to produce token-efficient architectural symbol outlines constrained to character budgets.
- [x] **2.4 New Graph MCP Tools for OCP Coder** ⚡ *(Parallel)*
  - Added `code_symbol_find`, `code_blast_radius`, and `code_repomap` directly to `packages/product/src/workspace-mcp.ts`.

### Milestone 3: Minimalized UI Architecture & Decoupling
- [x] **3.1 Backend API Decoupling & Worktree / Telemetry Endpoints** 🟢 *(Sequential)*
  - Added endpoints `/api/telemetry/traces`, `/api/telemetry/traces/detail`, `/api/telemetry/mode`, `/api/worktrees`, `/api/worktrees/discard`, `/api/worktrees/reconcile`.
- [ ] **3.2 Modern Frontend Package (`packages/ui`)** 🟢 *(Sequential)*
  - Decouple from server-rendered HTML into dedicated Vite + Preact package with typed client SDK.
- [x] **3.3 Minimalist Split-Screen Layout (Zen Mode) & Live Review Canvas** ⚡ *(Parallel)*
  - **Left**: Clean, floating conversation feed with compact status pills for tool calls.
  - **Right**: Dedicated, high-contrast Diff & Review Canvas with syntax-highlighted diffs, additions/deletions, one-click "Approve & Merge" and "Rollback Worktree".
- [x] **3.4 In-App Tracing UI & Flamegraph Inspection** ⚡ *(Parallel)*
  - Added dedicated Traces inspector tab with mode toggle (Off/Standard/Deep), token counters, and interactive flamegraph viewer.
- [ ] **3.5 Floating Picture-in-Picture (PiP) Virtual Computer** ⚡ *(Parallel)*
  - Convert the full-page Virtual Computer into a draggable, resizable PiP screen with a seamless "Take Control" shortcut.

### Milestone 4: Git Worktree Sandboxing & Parallel Swarm Execution
- [x] **4.1 Git Worktree Branch Isolation Engine** 🟢 *(Sequential)*
  - Implemented `createTaskWorktree`, `discardTaskWorktree`, `reconcileTaskWorktree` in `packages/product/src/worktree.ts`.
  - Isolate edits in `.ocp/worktrees/<task-id>`, keeping the developer's working directory 100% clean.
- [x] **4.2 Parallel Multi-Agent Task DAGs** 🟢 *(Sequential)*
  - Added `swarm_parallel_dispatch` and `swarm_reconcile` MCP tools for concurrent subtask execution.
  - Non-blocking worktree concurrency in `drainWorkspaceQueue` and `workspaceHasBusyTask`.
- [x] **4.3 Instant Rollback ("Time Machine")** ⚡ *(Parallel)*
  - Instant one-click rollback (`Cmd+Z` for agent work) by discarding isolated worktrees and task branches.

### Milestone 5: Cross-Compatibility Layer
- [x] **5.1 Dual-Mode MCP Server/Client (`ocp mcp`)** ⚡ *(Parallel)*
  - Implemented `ocp mcp [--workspace PATH]` in `packages/cli/src/main.ts` running JSON-RPC 2.0 over stdio for Claude Code, Cursor, or Gemini Antigravity.
- [ ] **5.2 VS Code & Cursor Companion Extension** ⚡ *(Parallel)*
  - Create a lightweight extension (`vscode-opencodingpartner`) integrating OCP Coder directly into VS Code/Cursor with `Cmd+K` inline generation and sidebar composer.
- [ ] **5.3 Terminal TUI (`ocp tui`)** ⚡ *(Parallel)*
  - Interactive, keyboard-driven terminal interface matching Claude Code ergonomics for terminal purists.

### Milestone 6: Distribution, Packaging & Long-Term Cloud Vision
- [ ] **6.1 Python `uv` / `pip` Installer Package** ⚡ *(Parallel)*
  - Package the OCP daemon into a PyPI distribution runnable via `uvx opencodingpartner` or `pip install opencodingpartner`.
- [ ] **6.2 Native Desktop Installers (Tauri: macOS DMG & Windows EXE)** 🟢 *(Sequential)*
  - Bundle OCP with Tauri (Rust core + Webview) into a native macOS `.dmg` (Universal binary) and Windows `.msi`/`.exe`.
  - Embed Monaco code editor, file tree, terminal, and live desktop stream in one native app window.
- [ ] **6.3 Always-On Cloud Infrastructure & Mobile Companion** 🟢 *(Sequential)*
  - Multi-tenant cloud daemon (`ocpd-cloud`) with persistent cloud sandboxes.
  - Mobile PWA / native iOS & Android client to review diffs, approve critical actions, and trigger routines from anywhere.
