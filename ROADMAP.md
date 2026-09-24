# Roadmap

OpenCodingPartner is a chat agent plus an orchestration agent swarm. The swarm stands up multiple agents: coding, QA, security, and computer. That is the product, including now.

## Now

The offline core runs without OpenClaw, Grok Build, or Laya installed.

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

- Start the OpenClaw gateway with `docker compose up -d openclaw-gateway` and send session traffic through it.
- Send a real coding prompt through Grok Build when the operator has a key.
- The computer agent can open a URL, read the screen, and type into one selector. Longer browser sessions can come later.
- Keep Laya on route and policy only. Weights stay on the operator machine.

## Later

Consult and enterprise help are optional and stay outside the core. The core stays free. Ads stay off. Payments stay out of the core.
