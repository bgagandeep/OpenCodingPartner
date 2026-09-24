# Architecture

OpenCodingPartner is a chat agent that runs an orchestration agent swarm. You ask that swarm to stand up agents. One turn can stand up a coding agent, a QA agent, a security agent, and a computer agent. Multi-agent is the product.

There is a temporary early-test cap of 8 agents in the code. That cap is for early tests only. It is not a one-worker rule.

## Product path

`ocp chat` is the product. With no message, it is a chat loop. With a message, it runs one turn and exits. `ocp doctor` prints green, yellow, or red for Laya weights, the meter, OpenClaw `/healthz`, the write-bridge plugin, and Playwright. It does not print keys. Yellow means that piece will be an honest skip in the transcript. `ocp prove coding` is a separate scripted turn in a temp sandbox. It uses a local runner, not a live meter. It mkdir, write, glob, patch, and `node --test`. Exit 0 means the files and the transcript matched. `ocp prove computer` is a scripted computer chain in a temp sandbox. A fake browser driver opens a page, scrolls, and checks the page text. Exit 0 means `gtm/last-run.json` recorded a passing scroll and screenshot. OpenClaw does not run the browser. Playwright is not required.

Each turn does this:

1. The chat agent opens the orchestration session `agent:board:main`.
2. System-1 picks the route. If Laya is installed, the turn runs `integrations/laya/predict.py` (`Router.predict`) and the transcript says `System-1: real Laya.` If Laya is absent or the call fails, the fallback router runs and the transcript says `System-1: fallback.`
3. That route becomes one manager plan: session `agent:board:main`, the roles, and the steps. If the OpenClaw gateway answers `/healthz`, the chat agent sends that plan with `sessions.send`, then calls `tools.invoke` for `skills.status` on that session. The accepted plan is the only standup list. The local swarm does not build a second plan. If the gateway is up but rejects the plan, the turn stops and no worker runs. If the gateway is down, the transcript prints the same plan object with source `local-manager` before workers run. That write is local. The transcript says `Write path: local sandbox.` After the session accepts the plan, this process asks the gateway to invoke `ocp_sandbox_write`, `ocp_sandbox_delete`, or `ocp_sandbox_rename`. That tool posts to the loopback write bridge in `packages/bundle`. The bridge runs the security gate, then writes the sandbox file. The transcript says `Write path: OpenClaw-driven.` The plugin the gateway loads is `integrations/openclaw-sandbox-write`. The gateway still blocks `fs_write`, `apply_patch`, and `sessions_spawn`. This process does not call those tools. If `ocp_sandbox_write` is not installed, the turn falls back to the built-in `write` tool with an absolute sandbox path. If that refuses, the file does not land. A general edit is drafted in a temp directory by the meter, then each file goes through the same bridge. The meter order stays LiteLLM, then OpenAI-compatible, then Grok Build.
4. The swarm stands up only the roles in that plan.
5. The security agent checks the path and the contents before a write.
6. The coding agent edits the sandbox. A general request is the prompt, with the sandbox as the working directory. The prompt also lists text files already in the sandbox, skipping secrets, so a follow-up turn is not blind. The same prompt starts with `Prior turns:` for this session and this sandbox only: up to six short lines, about 4k characters, with the user text and whether QA passed. Blocked secrets are not copied into that history. The lines are also written to `.ocp/prior-turns.json` in that sandbox and read back when the process starts again. Listing and grep skip `.ocp/`. One turn can list, grep, glob a relative pattern such as `src/**/*.ts` or `*.md`, read, patch, write, delete one file, rename one file, mkdir one directory, and run `node --test`, `pnpm test`, or `tsc --noEmit`, plus read-only `git status` (no args, `-sb`, or `--short --branch`) and `git diff` with relative paths, then feed those results back for another round in the same turn. Delete unlinks a single file after the security gate. It does not remove directories or `gtm/` evidence. When the gateway drove the turn, it invokes `ocp_sandbox_delete` or `ocp_sandbox_rename` on the same bridge. The transcript says `Delete path: OpenClaw-driven.` or `Rename path: OpenClaw-driven.` If that plugin tool is missing, the step runs in the local sandbox and the transcript says so. Rename moves one file to another relative path in the same sandbox and does not overwrite. Mkdir creates one relative directory and its parents. An existing directory is a no-op. A file, `../`, an absolute path, `gtm/`, `.ocp/`, or a secret path is refused. The transcript says `Mkdir path: local sandbox.` OpenClaw does not create directories. Grep is an in-process substring or `/pattern/` search. It skips secrets, binaries, and `gtm/`. The cap is five rounds. It stops on no more steps, a passing check, or an explicit done. A failed check is still retried up to two times with the command output in the prompt. The meter is chosen in this order: LiteLLM (`LITELLM_API_KEY` or `LITELLM_MASTER_KEY`, base `LITELLM_BASE_URL` or `http://127.0.0.1:4000/v1`), then `OPENAI_API_KEY` plus `OPENAI_BASE_URL`, then native Grok (`XAI_API_KEY` and `grok -p ... --cwd ... --output-format streaming-json`). LiteLLM is the operator's OpenAI-compatible proxy. It sits behind the same coding worker. It is not a required peer of the gateway. The transcript says which meter ran. The QA agent reviews the files that changed. The security agent checks the request before the edit and the written files after it. Without a key, a simple create-file message still uses the local sandbox worker. Any other request is refused. The offline path is not a stand-in for a live model.
7. The computer agent writes a go-to-market plan. Actions stay `executed: false` unless you pass `--computer-execute` or set `OCP_COMPUTER_EXECUTE=1` and name an http or https URL. Then this process opens that URL, reads the title and page text, and types into a CSS selector when the message says `type "text" into SELECTOR`. Playwright (headless Chromium) does that work here. `gtm/last-run.json` lists each step, and each finished step saves a screenshot under `gtm/`. A step is `executed: true` only if it ran. The message can chain `expect title`, `expect text`, `type ... into`, `click`, `navigate` to another URL on that same host, `wait SELECTOR` or a short `wait Nms` capped at 30 seconds, `scroll down`, `scroll up`, `scroll N` capped at 2000 pixels, or `scroll SELECTOR` to bring that element into view, and `expect selector ... value`. Each finished step records pass or fail in `gtm/last-run.json` and saves a screenshot. A failed step stops the chain. Later steps stay `executed: false`. The QA agent checks `gtm/assertion.json` and, after a coding write, any `expect file path to contain "..."` clause. A missing snippet, an empty file, or a file removed by security fails that review. A failed file or page check is retried up to two times. Each file retry uses the same write path as the first write. If QA still fails, the transcript says the fix budget is exhausted. OpenClaw does not run the browser and does not write those files.

The transcript is one block: session, route, which System-1 path ran, the manager plan, which agents stood up, the security decision, the file write, the QA result, and the computer plan.

## A turn

1. You send a message to the chat agent (`ocp` or `opencodingpartner`).
2. The orchestration agent swarm opens a session. The session shape follows OpenClaw: a binding of channel, account, and agent, and a session key like `agent:board:main`.
3. System-1 picks the route and does not write code. The real bridge is `integrations/laya/predict.py`. The chat turn runs it when `pnpm bundle:install` has created `.bundle/laya`, with `HF_HOME` pointed at `.bundle/laya/hf`. Otherwise the transcript says the fallback ran. The offline demo does not download weights.
4. The swarm stands up the agents the route needs. A build-and-sell request stands up all four roles.
5. The security agent checks the path and the file contents before any write. It blocks path escape and secrets.
6. The coding agent writes files. Offline, a local sandbox worker does the write. The Grok Build seam builds `grok -p "<prompt>" --cwd <dir> --output-format streaming-json` and calls an injected runner. The demo does not spawn `grok`.
7. The QA agent checks the file that was written.
8. The computer agent records a go-to-market action plan. With live execution off, no browser runs and each action is `executed: false`. With live execution on, Playwright opens the named URL, reads the screen, and types into one selector when you ask.

Turns on the same session run one after another. The same message on the same sandbox replays the stored result.

## Which tool runs what

| User-facing name | Runs on |
| --- | --- |
| Chat agent / chat bot | OpenCodingPartner CLI + orchestration |
| Orchestration agent swarm | OpenClaw-class gateway ([openclaw/openclaw](https://github.com/openclaw/openclaw), MIT). Docs: [docs.openclaw.ai](https://docs.openclaw.ai/). We do not vendor this code. |
| Coding agents + QA agents | Grok Build ([xai-org/grok-build](https://github.com/xai-org/grok-build), Apache-2.0). Headless use: [scripting](https://docs.x.ai/build/cli/headless-scripting). We do not vendor this code. |
| Computer agents (GTM) | Computer-use worker seam. Offline, it only records the plan. With `--computer-execute`, Playwright opens the named URL, reads the screen, and can type into one selector from this process. |
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

`pnpm bundle:install` fetches the pinned packages into `.bundle/` and downloads the Laya English weights there. This repo does not commit their source or their weights. OpenClaw owns the session plan. A create-file after that plan uses the gateway `write` tool. General model edits still run in this process. We are not affiliated with those projects. Credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
