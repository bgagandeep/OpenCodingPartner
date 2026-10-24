# OpenCodingPartner (OCP) — Universal Agent Guide & Long-Term Memory

This file serves as the permanent system guide and project memory for all autonomous AI coding assistants (Gemini, Antigravity, Claude Code, Cursor, Codex, and OCP's internal agent swarms).

---

## 1. Project Identity & Architecture
**OpenCodingPartner (OCP)** is an open, provider-neutral ecosystem for persistent, autonomous AI engineering teammates. It operates locally by default, binds strictly to loopback (`127.0.0.1:4317`), and provides guarded workspace manipulation, human-in-the-loop approvals, a virtual computer desktop with "Take Control", and multi-agent coordination.

### Repository Layout (`packages/`)
- `packages/mesh`: Shared agent role definitions, session bindings (`agent:board:main`), and core contracts.
- `packages/policy`: Route selection, classifier, and command execution gating.
- `packages/workers`: Guarded filesystem tools, secret scanner (`securityGate`), and Playwright browser driver.
- `packages/swarm`: In-memory role registry and agent dispatch.
- `packages/gateway`: Chat turn coordination, Slack/Telegram channel delivery, routines, fleet, and SDLC handoffs.
- `packages/bundle`: Toolchain installers and legacy runtime discovery.
- `packages/product`: Application core: JSON state (`bots.json`, `tasks.json`), native ACP adapter (`ocp-agent` / `ocp-coder`), workspace MCP server (`workspace-mcp.ts`), virtual desktop (`computer-desktop.ts`), vault (`vault.ts`), plugins, routines, usage tracking, and the loopback server (`server.ts`).
- `packages/cli`: CLI interface (`ocp app`, `ocp bot`, `ocp task run`, `ocp prove`).

---

## 2. Core Architecture Directives & SOTA Roadmap

All future development follows the roadmap specified in `docs/technical-spec.md`. Key pillars:

### I. Codebase Graph Intelligence (AST, SCIP & RepoMap)
- **Tree-sitter CSTs**: Multi-language concrete syntax tree parsing (TypeScript, JS, Python, Go, Rust, C/C++).
- **Code Property Graph (CPG)**: Local SQLite storage (`.ocp/graph.sqlite`) capturing nodes (files, classes, functions, interfaces, HTTP routes) and edges (`calls`, `imports`, `implements`, `references`).
- **Personalized PageRank RepoMap**: High-signal, token-efficient context compression injecting only structurally relevant symbol outlines into prompts.
- **Blast-Radius Tools**: MCP tools (`code_symbol_find`, `code_get_callers`, `code_get_callees`, `code_blast_radius`) ensuring zero-regression code modifications.

### II. End-to-End Observability Engine (Toggleable)
- **Three Modes**:
  1. `OFF`: Zero overhead, silent production mode.
  2. `STANDARD`: Live token counter, dynamic model cost tracking, and tool outcome badges.
  3. `DEEP TRACE`: Hierarchical OpenTelemetry spans (`gen_ai.*` semantic conventions), interactive latency waterfall, and execution flamegraphs.
- **Local Trace Viewer**: In-app inspection with optional OTLP export to Langfuse, Arize Phoenix, or Jaeger.

### III. Minimalized User Interface (Zero-Clutter Progressive Disclosure)
- **Decoupled Frontend**: Transition from monolithic string generation in `server.ts` to a dedicated `packages/ui` package (Vite + modern CSS + lightweight reactive UI) communicating via typed WebSocket/SSE APIs.
- **Zen Mode**: Distraction-free chat stream on the left; high-contrast live Diff & Review Canvas (Monaco/CodeMirror) on the right with line-by-line approvals.
- **Omnibar / Command Palette (`Cmd+K`)**: Keyboard-first action launcher replacing the 15-tab drawer.
- **PiP Virtual Computer**: Draggable, resizable picture-in-picture desktop canvas with instant "Take Control".

### IV. Git Worktree Isolation & Parallel Swarm Execution
- **Worktree Sandboxing**: All file edits occur in isolated Git worktrees (`.ocp/worktrees/<task-id>`) before human review, keeping the user's working copy clean.
- **Multi-Agent Task DAGs**: Dynamic dependency graphs (Lead Architect -> Parallel Coder Bots in separate worktrees -> Parallel QA/Security Bots -> Reconciler).
- **Time Machine**: Instant one-click rollback (`Cmd+Z`) by discarding the task worktree.

### V. Universal Cross-Compatibility
- **Dual MCP Protocol**: OCP acts as both an MCP Host (consuming external servers) and an MCP Server (`ocp mcp`) consumed by Claude Code, Gemini Antigravity, or Cursor.
- **Cursor / VS Code Extension**: `vscode-opencodingpartner` for inline editing (`Cmd+K`) and Composer sidebar.
- **Terminal TUI**: `ocp tui` for fast, keyboard-driven terminal workflows.
- **Standalone Desktop IDE**: Bundled with Tauri (Rust core + Webview) embedding Monaco editor and virtual desktop.

### VI. Packaging & Long-Term Cloud Vision
- **Distribution**: Python `uv` / `pip` installer (`uvx opencodingpartner`), native macOS Universal DMG, and Windows EXE/MSI.
- **Cloud & Mobile**: Always-on cloud daemon (`ocpd-cloud`), persistent remote sandboxes, and Android/iOS companion apps for remote notifications, diff reviews, and approval gates.

---

## 3. Development Commands & Guidelines
- **Build**: `pnpm build` (`tsc -b`)
- **Run Dashboard**: `pnpm app` (`http://127.0.0.1:4317`)
- **Lint & Format**: `node scripts/lint.mjs` / `node scripts/lint.mjs --fix`
- **Branding Guard**: `node scripts/branding-guard.mjs` (strictly enforce product identity rules; see `scripts/branding-guard.mjs`)
- **Run Tests**: `node --test tests/invariants.test.mjs`
- **Safety Rule**: Never bypass guarded workspace tools or execute unvetted destructive shell commands without prior approval.
