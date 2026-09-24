# Roadmap

OpenCodingPartner is a chat agent plus an orchestration agent swarm. The swarm stands up multiple agents: coding, QA, security, and computer. That is the product, including now.

## Now

The offline core runs without OpenClaw, Grok Build, or Laya installed. `ocp doctor` tells a new operator which of those pieces are present. `ocp prove coding` runs one scripted coding turn with no API key: mkdir, write, glob, patch, and `node --test`. `ocp prove computer` runs one scripted computer chain with a fake browser driver: open, scroll, and check page text. OpenClaw does not run the browser. The offline demo still does not pretend they are live.

- Chat agent CLI: `ocp` and `opencodingpartner`.
- Orchestration agent swarm with an OpenClaw-shaped session (`agent:board:main`).
- Coding agent and QA agent on a Grok Build seam, or on the operator's LiteLLM proxy, with a local sandbox for real file writes and a QA check.
- Security agent gate before writes.
- Computer agent seam. It records a plan with `executed: false` until you pass `--computer-execute` and name a URL. Then Playwright opens that URL, reads the screen, and types into one selector when the message asks.
- System-1 uses installed Laya through `integrations/laya/predict.py`. `pnpm bundle:install` downloads the English weights into `.bundle/laya/hf`. The transcript says real or fallback.

A temporary early-test cap of 8 agents is in the code. It is temporary. The demo stands up four agents in one turn.

Ads are off. Payments are off in the core.

## Next

`pnpm bundle:install` already installs pinned OpenClaw, Grok Build, and Laya beside this repo. `ocp demo --live` checks that OpenClaw and Grok Build answer.

- The OpenClaw gateway can drive sandbox writes. After it accepts the session plan, it invokes the local write bridge (`ocp_sandbox_write`). The transcript says OpenClaw-driven. When the gateway is down, the same create-file is a local sandbox write. `fs_write` and `sessions_spawn` stay blocked.
- Start the OpenClaw gateway with `docker compose up -d openclaw-gateway` and send session traffic through it. Load `integrations/openclaw-sandbox-write` so the gateway can call the bridge.
- Send a real coding prompt through Grok Build when the operator has a key.
- A later chat turn on the same sandbox sees the text files already there and a short `Prior turns:` history for that session and sandbox. The meter prompt includes those files and skips secrets. History does not keep blocked secrets. It is stored in `.ocp/prior-turns.json` in that sandbox so it survives a restart. One coding turn can list, grep, glob a relative pattern such as `src/**/*.ts`, read, patch, write, delete one file, rename one file, mkdir one directory, and run `node --test`, `pnpm test`, or `tsc --noEmit`, plus read-only `git status` and `git diff` with relative paths, and `git log --oneline -n N` with N from 1 to 20, then take more rounds from those results (up to ten). When the gateway drove the turn, delete and rename use `ocp_sandbox_delete` and `ocp_sandbox_rename`. The transcript says OpenClaw-driven. A missing plugin falls back to the local sandbox. Rename refuses an existing target, `gtm/`, and a secret source. Mkdir creates one relative directory locally. OpenClaw does not create directories. Rmdir removes one empty directory locally. OpenClaw does not remove directories. The coding agent can add and complete todos in that turn. The list is local, capped at 12, and stored in `.ocp/todos.json`. Secrets and `../` are refused. OpenClaw does not keep the list. A file or a non-empty directory is refused. An existing directory is a no-op. A file, `../`, `gtm/`, `.ocp/`, or a secret path is refused. Grep returns path and line snippets so the model can edit the hit file without reading the whole tree. A failed check is still retried up to two times.
- The computer agent can run a short chain: open, read, type, click, navigate on the same host, wait for a selector, scroll the page or a selector into view, press Enter, Escape, Tab, Backspace, or an arrow key. Any other key fails. It can check a title, page text, or selector value. A wait longer than 30 seconds fails. A scroll larger than 2000 pixels fails. OpenClaw does not run the browser. A failed step is recorded in `gtm/last-run.json` and later steps stay unexecuted. The QA agent fails a coding write when expected file text is missing, a file is empty, or security removed it. A failed file or page check is retried up to two times on the same write path, then the transcript says the budget is exhausted. Longer browser sessions can come later.
- Keep Laya on route and policy only. Weights stay on the operator machine.

## Later

Consult and enterprise help are optional and stay outside the core. The core stays free. Ads stay off. Payments stay out of the core.
