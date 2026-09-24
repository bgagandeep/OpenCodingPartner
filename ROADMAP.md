# Roadmap

OpenCodingPartner is a chat agent plus an orchestration agent swarm. The swarm stands up multiple agents: coding, QA, security, and computer. That is the product, including now.

## Now

The offline core runs without OpenClaw, Grok Build, or Laya installed. `ocp doctor` tells a new operator which of those pieces are present. The offline demo still does not pretend they are live.

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
- A later chat turn on the same sandbox sees the text files already there. The meter prompt includes those files and skips secrets. One coding turn can list, read, patch, write, and run `node --test`, then take more rounds from those results (up to five). A failed check is still retried up to two times.
- The computer agent can run a short chain: open, read, type, and check a title, page text, or selector value. A failed step is recorded in `gtm/last-run.json` and later steps stay unexecuted. The QA agent fails a coding write when expected file text is missing, a file is empty, or security removed it. A failed file or page check is retried up to two times on the same write path, then the transcript says the budget is exhausted. Longer browser sessions can come later.
- Keep Laya on route and policy only. Weights stay on the operator machine.

## Later

Consult and enterprise help are optional and stay outside the core. The core stays free. Ads stay off. Payments stay out of the core.
