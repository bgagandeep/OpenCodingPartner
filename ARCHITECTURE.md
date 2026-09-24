# Architecture

OpenCodingPartner is a chat agent that runs an orchestration agent swarm. You ask that swarm to stand up agents. One turn can stand up a coding agent, a QA agent, a security agent, and a computer agent. Multi-agent is the product.

There is a temporary early-test cap of 8 agents in the code. That cap is for early tests only. It is not a one-worker rule.

## Product path

`ocp chat` is the product. With no message, it is a chat loop. With a message, it runs one turn and exits.

Each turn does this:

1. The chat agent opens the orchestration session `agent:board:main`.
2. System-1 picks the route. If Laya is installed, the turn runs `integrations/laya/predict.py` (`Router.predict`) and the transcript says `System-1: real Laya.` If Laya is absent or the call fails, the fallback router runs and the transcript says `System-1: fallback.`
3. That route becomes one manager plan: session `agent:board:main`, the roles, and the steps. If the OpenClaw gateway answers `/healthz`, the chat agent sends that plan with `sessions.send`, then calls `tools.invoke` for `skills.status` on that session. The accepted plan is the only standup list. The local swarm does not build a second plan. If the gateway is up but rejects the plan, the turn stops and no worker runs. If the gateway is down, the transcript prints the same plan object with source `local-manager` before workers run. OpenClaw does not write the sandbox itself: its tool API blocks remote `fs_write` and `sessions_spawn`. After the session accepts the plan, the file edit still runs from this process.
4. The swarm stands up only the roles in that plan.
5. The security agent checks the path and the contents before a write.
6. The coding agent edits the sandbox. A general request is the prompt, with the sandbox as the working directory. Native Grok uses `XAI_API_KEY` and the `grok` binary (`grok -p ... --cwd ... --output-format streaming-json`). An OpenAI-compatible meter uses `OPENAI_API_KEY` and `OPENAI_BASE_URL` (LiteLLM or OpenRouter) and writes the files the model returns. The QA agent reviews the files that changed. The security agent checks the request before the edit and the written files after it. Without a key, a simple create-file message still uses the local sandbox worker. Any other request is refused with a clear note that general edits need `XAI_API_KEY` or `OPENAI_API_KEY` and `OPENAI_BASE_URL`. The offline path is not a stand-in for Grok Build.
7. The computer agent writes a go-to-market plan. Actions stay `executed: false` unless you pass `--computer-execute` or set `OCP_COMPUTER_EXECUTE=1` and name an http or https URL. Then this process opens that URL with Playwright (headless Chromium), saves `gtm/last-run.json` and `gtm/last-screenshot.png` in the sandbox, and marks that action `executed: true`. OpenClaw does not run the browser and does not write those files.

The transcript is one block: session, route, which System-1 path ran, the manager plan, which agents stood up, the security decision, the file write, the QA result, and the computer plan.

## A turn

1. You send a message to the chat agent (`ocp` or `opencodingpartner`).
2. The orchestration agent swarm opens a session. The session shape follows OpenClaw: a binding of channel, account, and agent, and a session key like `agent:board:main`.
3. System-1 picks the route and does not write code. The real bridge is `integrations/laya/predict.py`. The chat turn runs it when `pnpm bundle:install` has created `.bundle/laya`, with `HF_HOME` pointed at `.bundle/laya/hf`. Otherwise the transcript says the fallback ran. The offline demo does not download weights.
4. The swarm stands up the agents the route needs. A build-and-sell request stands up all four roles.
5. The security agent checks the path and the file contents before any write. It blocks path escape and secrets.
6. The coding agent writes files. Offline, a local sandbox worker does the write. The Grok Build seam builds `grok -p "<prompt>" --cwd <dir> --output-format streaming-json` and calls an injected runner. The demo does not spawn `grok`.
7. The QA agent checks the file that was written.
8. The computer agent records a go-to-market action plan. With live execution off, no browser runs and each action is `executed: false`. With live execution on, Playwright opens the named URL from this process.

Turns on the same session run one after another. The same message on the same sandbox replays the stored result.

## Which tool runs what

| User-facing name | Runs on |
| --- | --- |
| Chat agent / chat bot | OpenCodingPartner CLI + orchestration |
| Orchestration agent swarm | OpenClaw-class gateway ([openclaw/openclaw](https://github.com/openclaw/openclaw), MIT). Docs: [docs.openclaw.ai](https://docs.openclaw.ai/). We do not vendor this code. |
| Coding agents + QA agents | Grok Build ([xai-org/grok-build](https://github.com/xai-org/grok-build), Apache-2.0). Headless use: [scripting](https://docs.x.ai/build/cli/headless-scripting). We do not vendor this code. |
| Computer agents (GTM) | Computer-use worker seam. Offline, it only records the plan. With `--computer-execute`, Playwright opens the named URL from this process. |
| Security agents | Policy/security worker seam. It runs in the coding path, before the write. |

Laya is System-1: it only picks the route. Package: [laya on PyPI](https://pypi.org/project/laya/) (Apache-2.0, pinned at 0.3.13). Weights: [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya), English checkpoint only. `pnpm bundle:install` downloads about 800 MB into `.bundle/laya/hf`. That directory is not committed. The call shape is `router.predict(state, questions, model="english")`. Question types are choice, score, and noul.

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
2. Coding and QA agents call the bundled `grok` binary through the Grok Build runner (`grok -p ... --cwd ... --output-format streaming-json`) when `XAI_API_KEY` is set. `OPENAI_API_KEY` plus `OPENAI_BASE_URL` selects the OpenAI-compatible meter instead. The key stays in the operator environment. This repo does not store it. If no key is set, that step is skipped.

The report says what ran and what was skipped. The offline sandbox demo does not use this path. Optional gateway auth is `OPENCLAW_GATEWAY_TOKEN`. Do not put that token in the repo.

## Packages

| Package | Job |
| --- | --- |
| `mesh` | Roles, session binding, temporary agent cap |
| `policy` | System-1 route (real Laya result or fallback) |
| `swarm` | Stand up, list, and dispatch agents |
| `workers` | Local coding write, QA check, security gate, computer plan, Grok Build argv |
| `gateway` | One chat turn |
| `cli` | `ocp` and `opencodingpartner` |
| `bundle` | Pinned installer and live probe |

## Independence

`pnpm bundle:install` fetches the pinned packages into `.bundle/` and downloads the Laya English weights there. This repo does not commit their source or their weights. OpenClaw owns the session plan. Coding workers in this process write sandbox files. We are not affiliated with those projects. Credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
