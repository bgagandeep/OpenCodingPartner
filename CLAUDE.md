# CLAUDE.md — Claude Code Guidelines for OpenCodingPartner

This document guides Claude Code when working in the OpenCodingPartner (OCP) repository.

## Commands
- Build: `pnpm build` (runs `tsc -b`)
- Run App: `pnpm app` (starts loopback dashboard at `http://127.0.0.1:4317`)
- Test: `node --test tests/invariants.test.mjs`
- Lint: `node scripts/lint.mjs`
- Brand Guard: `node scripts/branding-guard.mjs`
- Demo: `pnpm demo`

## Architecture & Code Guidelines
- **Monorepo**: Pnpm workspace with 8 core packages under `packages/` (`mesh`, `policy`, `workers`, `swarm`, `gateway`, `bundle`, `product`, `cli`).
- **Guarded Filesystem**: File modifications are protected by `packages/product/src/workspace-mcp.ts` and `packages/workers`. Reads and patches are bounded (500 KB), symlink escapes are rejected, and secret patterns are redacted via `securityGate`.
- **Zero Ambiguity & Branding Rules**:
  - The product name is **OpenCodingPartner** (or **Open Coding Partner** / **OCP**).
  - Do not reference forbidden trademark strings (see `scripts/branding-guard.mjs`).
  - Core product docs keep ads and in-app payments OFF.
  - Loopback bind is strictly `127.0.0.1:4317`.

## Technical Strategy & Roadmap (See docs/technical-spec.md)
1. **Observability Engine**: OpenTelemetry `gen_ai.*` tracing with toggleable modes (`off`, `minimal`, `full`), real-time token/cost metering, and waterfall flamegraph views.
2. **Codebase Graph Intelligence**: Tree-sitter CST parsing, SQLite Code Property Graph (`.ocp/graph.sqlite`), PageRank RepoMap context compression, and blast-radius tools (`code_blast_radius`).
3. **Minimalized UI**: Decouple `server.ts` into `packages/ui` (Vite + modern CSS), Zen dual-pane layout (Chat + Monaco Diff Canvas), Command Palette (`Cmd+K`), and PiP Virtual Computer.
4. **Git Worktree Sandboxing & Swarms**: Edit in isolated Git worktrees (`.ocp/worktrees/<task-id>`), multi-agent task DAGs, and instant `Cmd+Z` rollback.
5. **Cross-Compatibility**: Dual MCP server/host (`ocp mcp`), Cursor/VS Code extension, terminal TUI (`ocp tui`), and Tauri desktop IDE.
6. **Packaging & Cloud Vision**: `uv`/`pip` distribution, Tauri macOS DMG & Windows EXE, always-on cloud daemon (`ocpd-cloud`), and iOS/Android companion apps.
