# OpenCodingPartner (OCP)

**OpenCodingPartner (OCP)** is an open-source (`Apache-2.0`), local-first, provider-neutral ecosystem for building and running persistent AI teammates, centered on **OCP Agent** and **OCP Coder**.

Teammates powered by **OCP Agent** and **OCP Coder** (optional external ACP binaries, or the built-in native Node.js ACP runtime) can route through **OpenRouter** or any local OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, or a custom base URL) with **zero vendor or regional lock-in**. There is no default model: you choose one. Every teammate shares identity, conversation continuity, guarded workspace tools, persistent workspace memory, bounded task history recall, approval flows, and a dedicated **Virtual Computer Desktop** with mouse, keyboard, browser control, and a live dashboard stream when a display is running.

The core is free forever and open source. The operator owns the meter. The full coding partner (**OCP Coder**) is included. Seats and credit packs in Settings are design only. Billing is inert. No charge is made. Ads are off. Payments are off in the core.

Start with [Onboarding](docs/onboarding.md). That guide is the first-run path: install, choose a model, spawn a team, and learn the limits. [The teammate path](docs/parity-path.md) is what still has to be built before this project is in the same category as other open coworkers. The sentence that is true today is the one in the next paragraphs. [ARCHITECTURE.md](ARCHITECTURE.md) is the design, and [ROADMAP.md](ROADMAP.md) is what is in this tree and what is still ahead.

The app binds to loopback (`127.0.0.1`) only. There is no default model and no hosted signup. You bring an OpenRouter key or a local OpenAI-compatible server. Dark is the first theme. Light and System are in the header.

---

## Key Features

- **Unified `OCP Agent` & `OCP Coder` Ecosystem**
  - **OCP Agent (`ocp-agent`)**: General, research, QA, security, coding, and computer-use teammate runtime. Uses an optional external ACP binary when installed, otherwise the built-in native ACP runtime.
  - **OCP Coder (`ocp-coder`)**: Dedicated coding teammate runtime. Uses an optional external ACP binary when installed, otherwise the built-in native ACP runtime.
- **Provider freedom (OpenRouter and local OpenAI-compatible servers)**
  - Configure any bot with OpenRouter or an OpenAI-compatible base URL (Ollama, LM Studio, vLLM, custom).
  - Open Coding Partner writes isolated per-bot runtime profiles with telemetry, feedback, and trace uploads disabled.
- **Dedicated Virtual Computer Desktop (Mouse, Keyboard, Browser & Human Takeover)**
  - **Linux**: Boots an isolated `1280x800` virtual X11 computer display per workspace (`Xvnc` + `xdotool` + Google Chrome + `ffmpeg` live frame capture).
  - **macOS**: Uses built-in macOS Quartz (`CGEvent`), `System Events`, `screencapture`, and Chrome/`open` (`macos:0`) with zero external packages required.
  - Bots can inspect the screen (`computer_screen`), move/click/drag/scroll the mouse (`computer_mouse`), type text or press key combinations (`computer_keyboard`), and open pages in Chrome (`computer_browser`).
  - From the Web Dashboard, a person can watch the live screen, click the canvas, type, or click **Take Control** to pause bot input while signing in, then **Return control** to the bot.
- **Guarded Workspace MCP Server (`opencodingpartner-workspace`)**
  - **Workspace File Tools**: `workspace_list`, `workspace_read`, `workspace_grep`, `workspace_glob`, `workspace_write`, `workspace_patch`, `workspace_append`, `workspace_delete`, `workspace_rename`, `workspace_copy`, `workspace_mkdir`, `workspace_rmdir` (bounded to 500 KB, symlink-safe, and guarded by secret-pattern scanning).
  - **Persistent Workspace Memory**: `memory_remember`, `memory_search`, and `memory_forget` stored per workspace in `<OCP_DATA_DIR>/memories/<workspace-hash>/MEMORY.md`.
  - **Cross-Session Task History Recall**: `history_search` and `history_read` for searching and reading prior task transcripts and specialist reviews in the same workspace.
  - **Compact Tool Discovery**: `tool_search`, `tool_describe`, and `tool_call` for progressive tool discovery.
- **Specialist Review Handoffs & Explicit Approvals**
  - Pair a primary coding bot with a separate **QA** or **security** bot in the same workspace for automatic post-task review with Git diff inspection.
  - Consequential tool actions require explicit one-action approval (`Allow once` or `Deny`) and fail closed when unattended.

---

## Prerequisites

### Required
- **Node.js `>= 22.14`** and **pnpm** (via Corepack: `corepack enable`).
- **Git** (used for workspace change tracking and diff review).

### Optional (Recommended for Full Capabilities)
- **Docker Engine / Desktop**: Used by default for **OCP Agent** terminal container isolation (`--isolation docker`). Bots configured with `--isolation host` run on the host without Docker.
  - [Linux Engine](https://docs.docker.com/engine/install/) · [macOS Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) · [Windows Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
- **External runtime CLIs** (optional): Open Coding Partner includes a built-in native ACP runtime. Optional `ocp-agent` / `ocp-coder` binaries on `PATH` are used when present. Credits for those upstream projects are in [NOTICE](NOTICE).
- **Computer Desktop Support**:
  - **macOS**: Built-in out of the box (`screencapture`, `osascript` Quartz/System Events, and Chrome/`open`). Grant **Screen Recording** and **Accessibility** permissions to your terminal in *System Settings → Privacy & Security* when using live desktop control.
  - **Linux**: Install `tigervnc-standalone-server` (`Xvnc`), `xdotool`, `ffmpeg`, and `google-chrome` (or `chromium`) for isolated virtual X11 displays.

---

## Installation

Clone the repository, install dependencies, and build the TypeScript workspace:

```bash
git clone https://github.com/bgagandeep/OpenCodingPartner.git
cd OpenCodingPartner
corepack pnpm install
corepack pnpm build
```

Run the test suite to verify everything on your machine:

```bash
corepack pnpm test
```

---

## Quick Start

### 1. Start the Local Web Dashboard

Export your model provider API key (for example `OPENROUTER_API_KEY` or `LITELLM_API_KEY`) and start the local web application:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
corepack pnpm app
```

Open **<http://127.0.0.1:4317>** in your browser.

From the Web Dashboard you can:
1. **Check Local Readiness**: Verify that **OCP Agent**, **OCP Coder**, and **Docker** are ready.
2. **Create Teammates**: Choose a name, role (`coding`, `qa`, `security`, `research`, `computer`, `general`), runtime (`OCP Agent` or `OCP Coder`), workspace path, and provider (`OpenRouter`, OpenAI-compatible, or runtime default).
3. **Run Tasks & Review Diffs**: Assign a request to a teammate (with an optional QA or security reviewer handoff), stream live activity, approve or deny permission requests, and inspect changed files and Git diffs.
4. **Open the Virtual Computer**: Use **Virtual Computer** in the header to view the live `1280x800` screen, open a URL, click, type, or **Take Control**.

---

### 2. Use the CLI (`ocp`)

You can manage bots, tasks, backups, and diagnostics directly from the terminal using `corepack pnpm exec ocp` (or `node packages/cli/dist/main.js`):

#### Create Teammates

```bash
# 1. Create an OCP Coder bot routed through OpenRouter
export OPENROUTER_API_KEY="sk-or-v1-..."
corepack pnpm exec ocp bot create \
  --name "OCP Coder (OpenRouter)" \
  --role coding \
  --runtime ocp-coder \
  --provider openrouter \
  --model "anthropic/claude-sonnet-4" \
  --workspace .

# 2. Create an OCP Agent bot routed through a local OpenAI-compatible server (Ollama)
export LITELLM_API_KEY="local-key"
corepack pnpm exec ocp bot create \
  --name "OCP Agent (Local Ollama)" \
  --role coding \
  --runtime ocp-agent \
  --isolation host \
  --provider litellm \
  --endpoint "http://127.0.0.1:11434/v1" \
  --model "qwen2.5-coder:32b" \
  --workspace .

# 3. Create a QA Reviewer bot in the same workspace
corepack pnpm exec ocp bot create \
  --name "QA Reviewer" \
  --role qa \
  --runtime ocp-agent \
  --isolation host \
  --provider openrouter \
  --model "anthropic/claude-sonnet-4" \
  --workspace .
```

#### List Teammates & Run Tasks

```bash
# List configured bots
corepack pnpm exec ocp bots list

# Run a task with a bot
corepack pnpm exec ocp task run <BOT_ID> --text "Inspect this repository and summarize the package layout."

# Run a coding task with an automatic QA specialist review handoff
corepack pnpm exec ocp task run <CODER_BOT_ID> \
  --review-by <QA_BOT_ID> \
  --text "Add input validation tests and verify edge cases."

# List tasks and inspect full task details + Git diff
corepack pnpm exec ocp tasks list
corepack pnpm exec ocp task show <TASK_ID>
```

---

## Virtual Computer Desktop & Human Takeover

Every bot workspace has access to an isolated virtual computer (`computer-desktop.ts`) exposed through both the Web Dashboard and four MCP tools:

| MCP Tool | Description |
| --- | --- |
| `computer_screen` | Boot or attach to the bot's virtual X11 display (`Xvnc`), capture a `1280x800` PNG frame to `gtm/last-frame.png`, and return display geometry, mouse coordinates, and active window title. |
| `computer_mouse` | Control the mouse (`move`, `click`, `double_click`, `right_click`, `middle_click`, `down`, `up`, `drag`, `scroll`, `position`) at `(x, y)` coordinates. |
| `computer_keyboard` | Type text (`type`) or send key/hotkey combinations (`key` / `hotkey`, e.g. `Return`, `Tab`, `Escape`, `BackSpace`, `ctrl+l`, `ctrl+c`). |
| `computer_browser` | Launch or navigate Google Chrome inside the bot's virtual computer display with an isolated browser profile and capture an updated screenshot. |

### Human Takeover Protocol
- When a person clicks **Take Control** in the dashboard (or sends `POST /api/bots/:id/computer` with `{"kind": "takeover"}`), the workspace computer state switches to `control: "human"` (`status: "held"`).
- While a person holds the computer, a bot call to `computer_mouse`, `computer_keyboard`, or `computer_browser` is refused until they click **Return control** (`{"kind": "return"}`).

---

## Configuration & Data Storage

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | API key for bots configured with `--provider openrouter`. |
| `LITELLM_API_KEY` / `LITELLM_MASTER_KEY` | API key for bots configured with `--provider litellm` (or custom `--api-key-env`). |
| `OCP_DATA_DIR` | Override the local directory where `state.json`, isolated bot profiles, and workspace memories are stored. |
| `OCP_AGENT_BIN` / `OCP_HERMES_BIN` | Path to a custom `hermes` executable for `ocp-agent` (defaults to `hermes` on `PATH`, then built-in `native-acp.js`). |
| `OCP_CODER_BIN` / `OCP_GROK_BIN` | Path to a custom `grok` executable for `ocp-coder` (defaults to `grok` on `PATH`, then built-in `native-acp.js`). |
| `OCP_COMPUTER_DISPLAY` | Optional X11 display override (e.g. `:99`) for the virtual computer desktop. |

### Local State & Backups
- By default, OpenCodingPartner stores local state in:
  - **Linux**: `$XDG_DATA_HOME/opencodingpartner` (default `~/.local/share/opencodingpartner`)
  - **macOS**: `~/Library/Application Support/OpenCodingPartner`
  - **Windows**: `%LOCALAPPDATA%/OpenCodingPartner`
- API keys are **never** written to `state.json`, task logs, or generated profile files.
- **Backup & Restore**:
  ```bash
  # Create a private backup of bots, tasks, memories, and profiles
  corepack pnpm exec ocp backup --to /path/to/new-backup

  # Restore into a new data directory (optionally remapping moved project workspaces)
  corepack pnpm exec ocp restore \
    --from /path/to/new-backup \
    --to /path/to/restored-data \
    --workspace-from /old/projects \
    --workspace-to /new/projects
  ```

---

## Legacy Sandbox & Integrations

The repository also retains its earlier sandbox and connected-stack CLI (`ocp demo`, `ocp prove`, `ocp doctor`, and swarm orchestration). See the [Legacy Sandbox Guide](docs/legacy-sandbox.md) for details.

---

## Credits

| Piece | License | Credit |
| --- | --- | --- |
| OpenClaw | MIT | OpenClaw Foundation — https://github.com/openclaw/openclaw |
| Grok Build | Apache-2.0 | xAI (SpaceXAI) — https://github.com/xai-org/grok-build |
| Laya | Apache-2.0 | Convai Innovations — https://pypi.org/project/laya/ and https://huggingface.co/convaiinnovations/laya |
| LiteLLM | MIT | BerriAI — https://github.com/BerriAI/litellm |
| Hermes Agent | MIT | Nous Research — https://github.com/NousResearch/hermes-agent — powers the OCP Agent ACP runtime; install separately |
| OpenCodingPartner (OCP Agent & OCP Coder) | Apache-2.0 | OpenCodingPartner contributors |

Full wording is in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Independence

Open Coding Partner is independent of the upstream projects named in Credits. **OCP Agent** and **OCP Coder** are the user-facing runtimes; optional external ACP binaries and OpenAI-compatible proxies are operator-configured. No upstream proprietary source is vendored.
