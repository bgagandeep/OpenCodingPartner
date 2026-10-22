# Contributing to OpenCodingPartner

Thank you for contributing to **OpenCodingPartner (OCP)**!

OpenCodingPartner is an open-source (`Apache-2.0`), local-first, provider-neutral AI teammate platform built around the **OCP Agent** and **OCP Coder** ecosystem. Before opening a pull request, please review [ARCHITECTURE.md](ARCHITECTURE.md) for the system design and [ROADMAP.md](ROADMAP.md) for current milestones.

---

## Monorepo Layout

OpenCodingPartner is a TypeScript ESM monorepo managed with `pnpm` workspaces:

| Package | Path | Responsibility |
| --- | --- | --- |
| `@opencodingpartner/product` | `packages/product` | Core local product: bot & task state (`index.ts`), loopback Web Dashboard (`server.ts`), built-in native ACP runtime (`native-acp.ts`), guarded workspace/memory/history/computer MCP server (`workspace-mcp.ts`), and virtual computer desktop controller (`computer-desktop.ts`). |
| `@opencodingpartner/cli` | `packages/cli` | `ocp` / `opencodingpartner` CLI entrypoints (`app`, `bot`, `task`, `backup`, `restore`, `demo`, `prove`, `doctor`). |
| `@opencodingpartner/workers` | `packages/workers` | Pure, zero-spawn sandboxed file helpers, unified diff patching, secret-pattern security gate, QA verifiers, and Playwright browser chain helpers. |
| `@opencodingpartner/gateway` | `packages/gateway` | Multi-agent turn orchestration, specialist review handoffs, computer tab state, and Slack/Telegram webhook verification. |
| `@opencodingpartner/policy` | `packages/policy` | Approval card state machine, partner agreements, and security policy gates. |
| `@opencodingpartner/swarm` | `packages/swarm` | Swarm manifest validation and multi-partner workspace layout. |
| `@opencodingpartner/mesh` | `packages/mesh` | System-1 router client and fallback routing. |
| `@opencodingpartner/bundle` | `packages/bundle` | Environment readiness doctor and optional bundle installer. |

---

## Development Setup

### Prerequisites
- **Node.js `>= 22.14`**
- **Corepack** (`corepack enable` to activate the pinned `pnpm` version)
- **Git**

### Install, Build & Test

```bash
# 1. Install workspace dependencies
corepack pnpm install

# 2. Build all TypeScript packages
corepack pnpm build

# 3. Whitespace / format lint
corepack pnpm lint

# 4. Branding guard (OCP-only user-facing copy)
corepack pnpm branding-guard

# 5. Run the full unit, integration, and invariant test suite
corepack pnpm test
```

GitHub Actions (`.github/workflows/ci.yml`) runs build, lint, branding-guard, and the full test suite on every pull request and on `main`. **Recommend protecting `main`**: require the CI job to pass, disallow direct pushes, and require a pull request before merge.

### Run the Local Web Dashboard in Development

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."   # or LITELLM_API_KEY
corepack pnpm app
```

The dashboard starts on <http://127.0.0.1:4317>.

---

## Architectural & Security Invariants

Every contribution must preserve these core project invariants (enforced by `tests/invariants.test.mjs` and package test suites):

1. **Provider-Neutral, Open-Source Core**
   - Keep bot identity, conversation sessions, task history, approvals, and workspace policies inside OpenCodingPartner.
   - Runtimes (**OCP Agent**, **OCP Coder**, and the built-in native ACP runtime) and model providers (**OpenRouter**, local OpenAI-compatible endpoints) must remain modular, replaceable integrations.
   - Ads are off and payments are off in the core.
2. **Strict Credential Hygiene**
   - Never store API keys or bearer tokens in `state.json`, bot definitions, task logs, or generated profile files (`config.yaml` / `config.toml`).
   - Redact credentials (`Bearer ...`, `sk-...`, `API_KEY=...`) from all runtime error messages before recording or displaying them.
3. **Fail-Closed Approvals & Bounded File Access**
   - Runtime permission requests (`session/request_permission`) must require explicit user confirmation (`Allow once` vs `Deny`) and fail closed when non-interactive or unapproved.
   - Workspace MCP file operations must stay inside the canonical workspace root, refuse symbolic link escapes, enforce the 500 KB file size bound, and pass `securityGate` secret scanning.
   - Do not import `node:child_process` inside `packages/workers/src` (worker helpers must remain pure file/data operations; process spawning belongs in `packages/product` or `packages/cli`).
4. **Honest Computer-Use & Isolation Claims**
   - Keep virtual computer actions (`computer_screen`, `computer_mouse`, `computer_keyboard`, `computer_browser`) tied to real execution and recorded frame evidence (`gtm/last-frame.png`).
   - Respect human takeover (`control: "human"`): when a human takes over the virtual computer, bot mouse, keyboard, and browser actions must be refused until control is returned.
5. **Clean-Room Apache-2.0 Licensing**
   - Prefer documented protocols (ACP JSON-RPC over stdio, MCP stdio, OpenAI-compatible HTTP/SSE) over copying upstream code.
   - Preserve attributions in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Pull Request Checklist

Before submitting a pull request, verify that:

- [ ] `corepack pnpm build` compiles cleanly with zero TypeScript errors.
- [ ] `corepack pnpm lint` and `corepack pnpm branding-guard` pass.
- [ ] `corepack pnpm test` passes all unit, integration, CLI E2E, and documentation invariant tests. The spec reporter must print the full test count (CLI tests forward captured stdout so TAP/spec lines are not swallowed).
- [ ] `git diff --check` reports no trailing whitespace or conflict markers.
- [ ] New features or bug fixes include focused tests in the corresponding `*.test.ts` file.
- [ ] No hardcoded local paths, `.env` files, or API keys are included in the diff.
