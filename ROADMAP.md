# Roadmap

OpenCodingPartner is a chat agent plus an orchestration agent swarm. The swarm stands up multiple agents: coding, QA, security, and computer. That is the product, including now.

## Now

The offline core runs without OpenClaw, Grok Build, or Laya installed.

- Chat agent CLI: `ocp` and `opencodingpartner`.
- Orchestration agent swarm with an OpenClaw-shaped session (`agent:board:main`).
- Coding agent and QA agent on a Grok Build seam, with a local sandbox for real file writes and a QA check.
- Security agent gate before writes.
- Computer agent seam that records a go-to-market plan and does not claim a live browser ran.
- Laya-class System-1 mock. The bridge script is `integrations/laya/predict.py`.

A temporary early-test cap of 8 agents is in the code. It is temporary. The demo stands up four agents in one turn.

Ads are off. Payments are off in the core.

## Next

- Point the swarm at an OpenClaw gateway the operator installed.
- Inject a Grok Build runner for coding agents and QA agents.
- Replace the computer-use stub with a real computer-use worker. Keep the record of what ran honest.
- Run the Laya bridge against a local install. Keep it on route and policy only.

## Later

Consult and enterprise help are optional and stay outside the core. The core stays free. Ads stay off. Payments stay out of the core.
