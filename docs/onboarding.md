# Onboarding

Open Coding Partner is a local agentic coding partner. You run it on your machine, choose the model, and keep the work in a workspace you can inspect. This page is the first hour.

## What you get

- A loopback dashboard at `http://127.0.0.1:4317` with team chat, a task queue, and a grouped inspector.
- Two runtimes you can assign to a bot: **OCP Agent** and **OCP Coder**. If an optional external binary is absent, the built-in runtime is used.
- Guarded workspace tools, approvals, a virtual computer, routines, skills, connectors, and a credentials vault.
- Dark as the first theme. Light and System (follows this device) are in the header, in Settings, and in the command palette.

## What this install does not include

- A model. There is no default model. The header shows **No model configured** until you set one.
- A hosted account, a public website, or a signup. The server refuses to bind to anything except `127.0.0.1`, `localhost`, or `::1`.
- A bundled OAuth client. Google and Microsoft connectors use a client you create. See [OAuth setup](oauth-setup.md).
- Voice, WhatsApp, or a pages surface. Those are still on the roadmap.
- A computer per bot, a readable audit log, and the rest of the teammate shape. [The path](parity-path.md) lists what is true today and what still has to land before a comparison with another product is fair.

Ads are off. Payments are off. Seats and credit packs in Settings are design only. No charge is made.

## Before you start

- Node.js `>= 22.14` and Corepack, so the pinned pnpm is available.
- Git, so the coding partner can show a diff.
- An API key for OpenRouter, or a local OpenAI-compatible server such as Ollama on `http://127.0.0.1:11434/v1`.
- Optional: Docker, when you want container isolation for **OCP Agent** terminal commands. Without Docker, create bots with host isolation and accept that those commands run on the host.
- Optional, for the virtual computer on Linux: `Xvnc`, `xdotool`, `ffmpeg`, and Chrome or Chromium. On macOS the desktop tools are built in, and Screen Recording plus Accessibility must be granted.

## Install and check

```bash
git clone https://github.com/bgagandeep/OpenCodingPartner.git
cd OpenCodingPartner
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

`pnpm test` compiles, then runs the suite in one process at a time. A failing test is a reason to stop before you point a model at a workspace.

## Start the dashboard

```bash
corepack pnpm app
```

Open <http://127.0.0.1:4317>. Leave the terminal running. Ctrl+C stops the app.

The page paints Dark before any script runs. Your later choice is stored for this user and also in a `ocp-theme` cookie so a reload does not flash the other theme. System follows the device.

A request from another site, or a `Host` header that is not this loopback port, is refused. A POST, PATCH, or DELETE without the page's local token is refused. Do not publish port 4317 on a public address. The bind check exists so that mistake fails closed.

## Choose a model

1. Open **Settings** in the header (on a phone, open **More**).
2. Paste an OpenRouter key, or set the local base URL to your OpenAI-compatible server and its key.
3. Set the default model id to a model that server actually serves.
4. Save. The header chip replaces **No model configured** with that model.

Keys stay in the local settings file for this OS user. They are not written into `state.json`, task logs, or the page you can share. `ocp doctor` prints whether a key is present and does not print the key.

Cheap mode on the composer can send smaller steps to a cheaper model id. Leave that id blank to keep every step on the model you set.

## Spawn a team and send work

1. Confirm the project selector points at the repository you want edited.
2. Click **Spawn Team**. That creates the starter bots in this project, including a team lead.
3. In the composer, choose who receives the message. Ask for something bounded, such as "Inspect this repository and summarize the package layout."
4. Watch **Activity** in the inspector. An approval card names the exact action. **Allow once** runs that action. **Deny** records the refusal. Nothing in that card runs because the card appeared.

Changed files and a bounded Git diff stay on the task. Pre-existing edits in the workspace are called out. A diff that looks like a secret is suppressed.

## Virtual computer

**Virtual Computer** in the header opens the `1280×800` screen for this workspace. The **LIVE** badge means a frame is being captured from that display.

**Take Control** pauses bot mouse, keyboard, and browser actions so you can sign in, pass a 2FA challenge, or type a password yourself. **Return control** hands the screen back. A bot cannot type a vault secret onto a sign-in, 2FA, or captcha page. Those pages ask you to take control.

If the Linux desktop packages are missing, the pane says so. It does not pretend a display is running.

## Routines, skills, and mail

- **Routines** take a five-field cron expression and an IANA timezone, or an interval, or an event. A signed webhook is optional. The signing secret is shown once and is not stored in the task log.
- **Skills** are instructions a bot can load. Read the "When to use" line before you enable one.
- **Drafts** hold a mail reply until you send it. **Do not send** leaves it unsent. OCP does not send mail because a draft exists.
- **Issue to PR** turns a GitHub or Linear issue into a task and a pull request. Merging stays with a person.

## Where your data lives

| System | Path |
| --- | --- |
| Linux | `$XDG_DATA_HOME/opencodingpartner` or `~/.local/share/opencodingpartner` |
| macOS | `~/Library/Application Support/OpenCodingPartner` |
| Windows | `%LOCALAPPDATA%/OpenCodingPartner` |

`OCP_DATA_DIR` overrides that directory. `ocp backup --to PATH` copies bot and task state. It refuses to overwrite a destination, and it does not copy the project workspace. `ocp restore` only restores into a new directory.

## If the first hour goes wrong

| What you see | What it means |
| --- | --- |
| **No model configured** and the bot has nothing to say | Settings has no usable model yet. Save a model id and a key or a local base URL. |
| The page will not load from another computer | The app is loopback only. Use the machine where `pnpm app` is running, or an SSH tunnel to `127.0.0.1:4317`. |
| Port 4317 is taken | `corepack pnpm exec ocp app --port 4318` |
| A cron of four fields, a name like `MON`, or a timezone that is not IANA | The routine is rejected. Use five numeric fields and a zone such as `America/New_York`. |
| Theme looks wrong for a moment after a click | Reload. A junk `ocp-theme` cookie is ignored. Dark, Light, and System are the only stored values. |
| Virtual computer stays empty on Linux | Install `Xvnc`, `xdotool`, `ffmpeg`, and Chrome or Chromium, then reconnect the stream. |
| An approval is waiting | The action has not run. Read the card. Allow once, deny, or dismiss it. Unattended runs fail closed. |

## After the first hour

Read [ARCHITECTURE.md](../ARCHITECTURE.md) before you change the runtime boundary, and [CONTRIBUTING.md](../CONTRIBUTING.md) before you open a pull request. [ROADMAP.md](../ROADMAP.md) lists what is already in this tree.
