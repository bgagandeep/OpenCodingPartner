# Roadmap

Open Coding Partner (OCP) is a local-first dashboard and CLI for persistent AI teammates: **OCP Agent** and **OCP Coder**. Model access is whatever OpenAI-compatible endpoint or OpenRouter key you configure. There is no default model.

See [Onboarding](docs/onboarding.md) for the first hour and [ARCHITECTURE.md](ARCHITECTURE.md) for internals. Upstream runtime credits stay in [NOTICE](NOTICE).

The public announcement window for this local tool is **1 November 2026 through 19 December 2026**. October is for the operator guide, honest limits, and edge-case tests. The announcement is a local install people clone and run. It is not a hosted signup.

## Now (in this tree)

- Web dashboard (`ocp app`): team chat, task queue, plan-before-write, sandboxed tests, Virtual Computer with a live frame and **Take Control**, approvals (Allow once / Always / Deny / Redirect).
- Themes: Dark (default), Light, and System, from the header, Settings, and the command palette. The choice is on the first paint.
- Inspector groups: Work, Team, Computer, Connect, Library, System. Connect includes connectors, channels, accounts, and the vault. Library includes skills, routines, and Issue to PR.
- Routines: five-field cron with an IANA timezone, intervals, events, and a signed inbound webhook. The secret is shown once.
- Draft-before-send mail cards. A person sends. **Do not send** leaves the draft unsent.
- Bring-your-own Google and Microsoft OAuth clients. OCP ships no OAuth client. Tokens stay in the vault.
- Usage meter and a hard cap. Cheap mode is a routing choice, not a second product.
- CLI: `ocp bot`, `ocp task`, `ocp backup` / `restore`, `ocp doctor`, `ocp prove`.
- Fail-closed approvals. Docker isolation unless a person sets host. The desktop says so when Xvnc is missing.
- The app binds to loopback only. A foreign `Origin` or `Host` is refused.
- CI: build, lint, branding guard (strict), full `pnpm test`.

The product is a chat agent plus an orchestration agent swarm (Lead) that can stand up a coding agent, QA agent, security agent, and computer agent. A temporary early-test cap of 8 agents remains in the code. Ads are off. Payments are off in the core.

One-off text/file CLI helpers (`ocp lower`, `ocp squeeze`, …) still exist for the legacy sandbox path. They are not the product. Prefer the dashboard and `ocp task run`. Set `OCP_EXTRA_CLI=1` only if you still need them documented in operator notes.

## Next

[The teammate path](docs/parity-path.md) is the record of the announcement-window proofs. Items 1 through 8 are in this tree, with tests. The README states that teammate shape and does not name this project as another product. In short:

1. A computer per bot, not one shared screen per workspace.
2. An audit page of permitted, refused, and failed actions.
3. A standing responsibility that survives a restart.
4. A thread addressed to more than one bot.
5. Continuing that thread into Slack or Telegram as a draft. Nothing is sent automatically.
6. Memory a person can correct or forget.
7. A named deny rule the audit row can quote.
8. `ocp doctor` printing local, hosted, or not configured, without the key and without a network call.

Voice, WhatsApp, a pages surface, a foreign agent protocol, and multi-person sign-in are not yet in this tree. A container boundary for standalone **OCP Coder** processes is still open: those processes use the operator's OS permissions today.

## Later

Optional consult or enterprise help stays outside the core. Ads stay off. Payments stay out of the core. A public multi-user service is out of scope until the loopback product is the one people can install without surprises.
