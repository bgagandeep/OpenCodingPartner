# Roadmap

Open Coding Partner (OCP) is a local-first dashboard and CLI for persistent AI teammates: **OCP Agent** and **OCP Coder**. Model access is whatever OpenAI-compatible endpoint or OpenRouter key you configure. There is no default model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals and [NOTICE](NOTICE) for third-party runtime credits.

## Now (in this tree)

- Web dashboard (`ocp app`): team chat, task queue, plan-before-write, sandboxed tests, Virtual Computer with a live MJPEG stream, approvals (Allow once / Always / Deny / Redirect).
- CLI: `ocp bot`, `ocp task`, `ocp backup` / `restore`, `ocp doctor`, `ocp prove`.
- Fail-closed approvals, Docker isolation unless a human sets host, honest desktop errors when Xvnc is missing.
- CI: build, lint, branding guard (strict), full `pnpm test`.

One-off text/file CLI helpers (`ocp lower`, `ocp squeeze`, …) still exist for the legacy sandbox path. They are not the product; prefer the dashboard and `ocp task run`. Set `OCP_EXTRA_CLI=1` only if you still need them documented in operator notes.

## Next

- Routines (cron + events) and Slack/Telegram **inside the dashboard**, not only the legacy CLI.
- Per-bot MCP connector control plane.
- Skills library, draft-before-send email cards, pages/canvas, voice, WhatsApp, async bot mailbox, bot-initiated hand-to-human for sign-in.

The product is a chat agent plus an orchestration agent swarm (Lead) that can stand up a coding agent, QA agent, security agent, and computer agent. A temporary early-test cap of 8 agents remains in the code. Ads are off. Payments are off in the core.

## Later

Optional consult/enterprise help stays outside the core. Ads stay off. Payments stay out of the core.
