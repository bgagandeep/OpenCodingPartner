# Architecture

OpenCodingPartner is a chat agent that runs an orchestration agent swarm. You ask that swarm to stand up agents. One turn can stand up a coding agent, a QA agent, a security agent, and a computer agent. Multi-agent is the product.

There is a temporary early-test cap of 8 agents in the code. That cap is for early tests only. It is not a one-worker rule.

## Product path

`ocp chat` is the product. With no message, it is a chat loop. With a message, it runs one turn and exits.

Each turn does this:

1. The chat agent opens the orchestration session `agent:board:main`.
2. If the OpenClaw gateway answers `/healthz`, the same message is sent with `sessions.send`. If it does not answer, the transcript says the gateway was skipped and the local swarm continues.
3. The swarm stands up a coding agent, a QA agent, a security agent, and a computer agent.
4. The security agent checks the path and the contents before a write.
5. The coding agent writes the file. It uses the bundled `grok` binary when `XAI_API_KEY` is set. Otherwise it uses the local sandbox worker. The QA agent then checks that file.
6. The computer agent writes a go-to-market plan. Actions stay `executed: false` unless you pass `--computer-execute`. Even then, this build does not run a live browser, so the actions stay `executed: false`.

The transcript is one block: session, route, which agents stood up, the security decision, the file write, the QA result, and the computer plan.

## A turn

1. You send a message to the chat agent (`ocp` or `opencodingpartner`).
2. The orchestration agent swarm opens a session. The session shape follows OpenClaw: a binding of channel, account, and agent, and a session key like `agent:board:main`.
3. A Laya-class System-1 router picks the route. It does not write code. Offline, a mock router runs. The real bridge is `integrations/laya/predict.py`. The demo does not run that script.
4. The swarm stands up the agents the route needs. A build-and-sell request stands up all four roles.
5. The security agent checks the path and the file contents before any write. It blocks path escape and secrets.
6. The coding agent writes files. Offline, a local sandbox worker does the write. The Grok Build seam builds `grok -p "<prompt>" --cwd <dir> --output-format streaming-json` and calls an injected runner. The demo does not spawn `grok`.
7. The QA agent checks the file that was written.
8. The computer agent records a go-to-market action plan. The offline stub does not run a live browser. Each action is stored with `executed: false`.

Turns on the same session run one after another. The same message on the same sandbox replays the stored result.

## Which tool runs what

| User-facing name | Runs on |
| --- | --- |
| Chat agent / chat bot | OpenCodingPartner CLI + orchestration |
| Orchestration agent swarm | OpenClaw-class gateway ([openclaw/openclaw](https://github.com/openclaw/openclaw), MIT). Docs: [docs.openclaw.ai](https://docs.openclaw.ai/). We do not vendor this code. |
| Coding agents + QA agents | Grok Build ([xai-org/grok-build](https://github.com/xai-org/grok-build), Apache-2.0). Headless use: [scripting](https://docs.x.ai/build/cli/headless-scripting). We do not vendor this code. |
| Computer agents (GTM) | Computer-use worker seam. Offline, it only records the plan. |
| Security agents | Policy/security worker seam. It runs in the coding path, before the write. |

Laya is System-1: it only picks the route. Package: [laya on PyPI](https://pypi.org/project/laya/) (Apache-2.0, pinned at 0.3.13). Weights: [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya). The call shape is `router.predict(state, questions, model=model)`. Question types are choice, score, and noul. We do not ship the weights.

## Packaging

```text
pnpm bundle:install
        |
        +-- .bundle/openclaw   npm openclaw@2026.9.6          orchestration agent swarm
        +-- .bundle/grok       npm @xai-official/grok@1.0.41   coding agents and QA agents
        +-- .bundle/laya       pip laya==0.3.13               System-1 bridge
        +-- docker compose     ghcr.io/openclaw/openclaw:2026.9.6
```

The chat agent reads `.bundle/stack.json` or `OCP_OPENCLAW_BIN`, `OCP_GROK_BIN`, and `OCP_LAYA_PYTHON`.

`pnpm demo:connected` (`ocp demo --live`) does two real steps:

1. It checks `GET /healthz` on the OpenClaw gateway (`http://127.0.0.1:18789`, or `OPENCLAW_GATEWAY_URL`). If the gateway answers, the chat agent sends a turn with `openclaw gateway call sessions.send` on session `agent:board:main`. If the `openclaw` binary is missing but HTTP is up, it uses `POST /v1/chat/completions`. If nothing answers `/healthz`, the chat turn is skipped.
2. Coding and QA agents call the bundled `grok` binary through the Grok Build runner (`grok -p ... --cwd ... --output-format streaming-json`). That call runs only when `XAI_API_KEY` is set. The key stays in the operator environment. This repo does not store it. If the key or the binary is missing, that step is skipped.

The report says what ran and what was skipped. The offline sandbox demo does not use this path. Optional gateway auth is `OPENCLAW_GATEWAY_TOKEN`. Do not put that token in the repo.

## Packages

| Package | Job |
| --- | --- |
| `mesh` | Roles, session binding, temporary agent cap |
| `policy` | Mock System-1 route |
| `swarm` | Stand up, list, and dispatch agents |
| `workers` | Local coding write, QA check, security gate, computer plan, Grok Build argv |
| `gateway` | One chat turn |
| `cli` | `ocp` and `opencodingpartner` |
| `bundle` | Pinned installer and live probe |

## Independence

`pnpm bundle:install` fetches the pinned packages into `.bundle/`. This repo does not include their source or their weights. We are not affiliated with those projects. Credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
