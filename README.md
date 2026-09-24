# OpenCodingPartner

OpenCodingPartner is an agentic coding tool. You talk to a chat agent. That chat agent runs an orchestration agent swarm. You ask the swarm to stand up agents.

A coding agent and a QA agent build and test the product. A computer agent helps sell it. A security agent checks the work inside the same coding setup.

A company with enough model hosting can replace day-to-day coding-team build, review, and ship work. This does not cover legal, spend, or brand. A startup can use it to bring an idea to life and to help sell that idea.

The core is free forever and open source. The operator owns the meter. Consult and enterprise help can come later. Ads are off. Payments are off in the core.

## First run

```bash
pnpm install
pnpm bundle:install
pnpm exec ocp doctor
```

`ocp doctor` prints green, yellow, or red. It does not print keys.

- Laya weights: green when `.bundle/laya` python and `.bundle/laya/hf` are present. The next chat can say `System-1: real Laya.` Yellow means the transcript will say `System-1: fallback.` System python is not Laya.
- Meter: set one of these, in this order. `LITELLM_API_KEY` or `LITELLM_MASTER_KEY` (optional `LITELLM_BASE_URL`, default `http://127.0.0.1:4000/v1`). Else `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Else `XAI_API_KEY` with the `grok` binary. Yellow `Meter: none` means a general edit will refuse. A simple create-file still writes on the local sandbox.
- OpenClaw: `docker compose up -d openclaw-gateway`. Doctor checks `GET /healthz`. Yellow means the chat turn writes locally and says `Write path: local sandbox.`
- Write bridge: load `integrations/openclaw-sandbox-write` on that gateway. Doctor checks that the plugin is in this repo. It does not prove the gateway loaded it. `fs_write` stays blocked.
- Playwright: yellow until you install it. Needed only for `--computer-execute`.

Prove-it chat, after doctor is green for the pieces you care about:

```bash
export LITELLM_API_KEY="the operator key"
pnpm exec ocp chat --sandbox .sandbox "Use Grok Build to create hello.txt with content:
hello
"
```

Scripted coding proof, with no meter key:

```bash
pnpm exec ocp prove coding
```

That command runs one local turn in a temp sandbox. It creates `src/`, writes a small add function, globs `src/**/*.mjs`, patches the function, and runs `node --test`. Exit 0 means those files and transcript lines matched. It prints `Passed.` It does not call LiteLLM, OpenAI, or Grok, and it does not print keys. `pnpm proof:coding` is different: that one needs a meter key.

Scripted computer proof, with no Playwright and no meter key:

```bash
pnpm exec ocp prove computer
```

That command opens `https://example.com` with a fake browser driver, scrolls, and checks the page text. It writes `gtm/last-run.json` with a pass and a screenshot. Exit 0 prints `Passed.` OpenClaw does not run the browser. It does not print keys.

Read the transcript. `System-1: real Laya.` or `System-1: fallback.` `Write path: OpenClaw-driven.` only if the gateway accepted the plan and the write landed. Otherwise `Write path: local sandbox.` `Meter: LiteLLM`, `Meter: OpenAI-compatible`, `Meter: Grok Build`, or `Meter: none`. The offline command `pnpm exec ocp demo --sandbox .sandbox` does not pretend those live pieces ran.

## Which tool runs what

| User-facing name | Runs on |
| --- | --- |
| Chat agent / chat bot | OpenCodingPartner CLI + orchestration |
| Orchestration agent swarm | OpenClaw-class gateway ([openclaw/openclaw](https://github.com/openclaw/openclaw), MIT) |
| Coding agents + QA agents | Grok Build ([xai-org/grok-build](https://github.com/xai-org/grok-build), Apache-2.0) |
| Computer agents (GTM) | Computer-use worker seam |
| Security agents | Policy/security worker seam in the coding environment |

We cite those projects. We do not copy their source into this repo. See [Credits](#credits) and [Independence](#independence).

## Install the connected stack

```bash
pnpm install
pnpm bundle:install
```

That one command installs pinned OpenClaw, Grok Build, and Laya under `.bundle/`. It uses npm and pip. It also downloads the Laya English checkpoint from Hugging Face into `.bundle/laya/hf` (about 800 MB; the first download often takes several minutes). Those weights are not committed. It does not copy upstream source trees into this repo. Upstream license files stay inside those installs.

Laya only, including the same weight download:

```bash
pnpm bundle:install:laya
```

System `python3` is not Laya. After either command, the next `ocp chat` turn uses the bundled Python and `HF_HOME=.bundle/laya/hf`. The transcript says `System-1: real Laya.`

Optional OpenClaw gateway:

```bash
docker compose up -d openclaw-gateway
```

The image is `ghcr.io/openclaw/openclaw:2026.9.6`.

## Run a chat turn

```bash
pnpm install
pnpm exec ocp chat --sandbox .sandbox
```

Type a message, then type `exit`. One turn stands up a coding agent, a QA agent, a security agent, and a computer agent. The transcript says what each one did.

A general request, such as "Add an add function in src/math.ts and a test in src/math.test.ts", is sent to the coding agent with the sandbox as the working directory. The meter prompt also includes the text files already in that sandbox, so a later turn on the same sandbox can see them. It also includes `Prior turns:` for this session and sandbox: the last six user messages and a short outcome (files written, QA pass or fail). A secret in a blocked write is not stored. Another sandbox does not see that history. The same lines are saved in `.ocp/prior-turns.json` inside that sandbox, so a new process still has them. That file is not listed or grepped into the prompt. Inside one turn the coding agent can list a directory, grep text files, glob a relative pattern such as `src/**/*.ts` or `*.md`, read a file, patch an existing file, write a new file, delete one file, rename one file, mkdir one directory, and run one of these checks: `node --test` plus relative paths, `pnpm test` with no extra arguments, or `tsc --noEmit` plus relative paths. It can also run `git status`, `git status -sb`, `git status --short --branch`, and `git diff` plus relative paths. Git add, commit, push, checkout, reset, and other writes are refused. A long diff is cut at 2000 characters and the observation says truncated. The working directory is the sandbox. Other commands are refused. Delete unlinks that file only. Rename moves one file to a new relative path and refuses to overwrite. It refuses a directory, a path outside the sandbox, and anything under `gtm/`. A secret file the security gate blocks is left in place. Mkdir creates one relative directory, including parents. An existing directory is left as it is. A path that is already a file, `../`, an absolute path, `gtm/`, `.ocp/`, or a secret path is refused. The transcript says `Mkdir path: local sandbox.` OpenClaw does not create directories. When the gateway drove the turn, delete and rename go through that bridge. The transcript says `Delete path: OpenClaw-driven.` or `Rename path: OpenClaw-driven.` If the plugin is missing, the same step runs in the local sandbox and the transcript says `Delete path: local sandbox.` or `Rename path: local sandbox.` Grep returns matching paths and short line snippets. It skips secrets, binary files, and `gtm/`. It then sees those tool results and can take another round, up to five rounds, in the same turn. It stops when the reply is done, there are no more steps, or the check passes. Other commands are refused. The transcript lists each round and each tool step. If `node --test` still fails, that output goes into the same two-retry fix loop. Secret files are left out of that prompt. The same chat session can take a follow-up: create `src/math.ts`, then ask for `src/math.test.ts`, then ask to fix a failing assert. Each turn has its own transcript and meter line. The QA agent then reviews the files that changed. The security agent checks the request first, and checks the written files after. A file that escapes the sandbox or contains a secret is removed.

That general path needs a meter. Prefer LiteLLM with `LITELLM_API_KEY` or `LITELLM_MASTER_KEY`. If those are unset, an OpenAI-compatible endpoint with `OPENAI_API_KEY` and `OPENAI_BASE_URL` is next. Native Grok (`XAI_API_KEY` and the `grok` binary) is last. Without a key, the chat agent says so. It does not pretend the offline sandbox can do open-ended edits. The transcript names the meter: `Meter: LiteLLM`, `Meter: OpenAI-compatible`, `Meter: Grok Build`, or `Meter: none`.

## LiteLLM

LiteLLM is an OpenAI-compatible proxy you run or already have. It is the operator's meter. It is not a second orchestration system. OpenClaw still owns the session plan. Coding workers in this process send chat completions to the proxy.

| Variable | Role |
| --- | --- |
| `LITELLM_API_KEY` | Key this process sends. Wins over `LITELLM_MASTER_KEY`. |
| `LITELLM_MASTER_KEY` | Same job when `LITELLM_API_KEY` is unset. This is the proxy's usual master key. |
| `LITELLM_BASE_URL` | Proxy URL. Defaults to `http://127.0.0.1:4000/v1` when a LiteLLM key is set. |
| `LITELLM_MODEL` | Model alias. Then `OPENAI_MODEL`. Then `gpt-4o-mini`. |
| `OPENAI_API_KEY` and `OPENAI_BASE_URL` | Used only when no LiteLLM key is set. OpenRouter fits here. |
| `XAI_API_KEY` | Native Grok, only when the other meters are unset and `grok` is installed. |

Remote proxy:

```bash
export LITELLM_API_KEY="the operator key"
export LITELLM_BASE_URL="https://your-litellm.example/v1"
export LITELLM_MODEL="your-alias"
pnpm exec ocp chat --sandbox .sandbox
```

Local proxy, bound to localhost. The example config is [examples/litellm/config.yaml](examples/litellm/config.yaml). `OPENAI_API_KEY` here is the provider key the proxy reads, not the key this chat agent sends.

```bash
export LITELLM_MASTER_KEY="the proxy key"
export OPENAI_API_KEY="the provider key"
docker compose up -d litellm
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
pnpm exec ocp chat --sandbox .sandbox
```

When Laya is installed (`pnpm bundle:install`, or `OCP_LAYA_PYTHON`), the chat turn calls `integrations/laya/predict.py` and the transcript says `System-1: real Laya.` A machine that only has system Python is not treated as Laya. The transcript then says `System-1: fallback. Laya is not installed.`

This simple message still writes a file on the local sandbox worker:

```text
Use Grok Build to create hello.txt with content:
hello
```

The security agent blocks a path that escapes the sandbox, and it blocks secrets. The QA agent checks the file that was written. The computer agent writes `gtm/action-plan.json`. Without `--computer-execute`, every computer action stays `executed: false` and no browser runs.

With `--computer-execute` (or `OCP_COMPUTER_EXECUTE=1`), the computer agent runs a short sequence in this process with headless Chromium through Playwright: open the http or https URL you name, read the title and page text, and, if you ask, type into one CSS selector. Example: `Open https://example.com and type "hello" into #hero`. Each step is `executed: true` only after it runs. `gtm/last-run.json` lists the steps. Each finished step also saves `gtm/step-1.png`, `gtm/step-2.png`, and `gtm/step-3.png` when that step ran. Local hosts, private addresses, metadata hosts, and URLs with a username or password are refused. A selector that looks like a script is refused and is not typed. Set `OCP_COMPUTER_ALLOW_HOSTS` to a comma-separated host list when you want a tighter allow list. Evidence stays under the sandbox `gtm/` directory. Notes redact secrets.

```bash
pnpm add playwright
pnpm exec playwright install chromium
pnpm exec ocp chat --sandbox .sandbox --computer-execute "Open https://example.com and type \"hello\" into #hero"
```

If Playwright or Chromium is missing, the turn says the browser did not finish. Steps that did not run stay `executed: false`.

A page check can chain steps in one message: `expect title "..."`, `expect text "..."`, `type "..." into SELECTOR`, `click SELECTOR` or `click "text"`, `navigate URL`, `wait SELECTOR`, `wait N` or `wait Nms` (capped at 30 seconds), `scroll down`, `scroll up`, `scroll N` (capped at 2000 pixels), `scroll SELECTOR`, and `expect selector SELECTOR value "..."`. `wait SELECTOR` waits until that selector is visible. A failed wait or scroll stops the chain. `scroll SELECTOR` brings that element into view. OpenClaw does not run the browser. `navigate` stays on the host you opened, or on a host in `OCP_COMPUTER_ALLOW_HOSTS`. It does not crawl other sites. Each step is recorded in `gtm/last-run.json` with pass or fail and a screenshot when it ran. If a step fails, later steps stay `executed: false` and the transcript names the failed step. The QA agent also reads `gtm/assertion.json`. It fails when the claim does not match, when execute is off, or when the browser did not start.

After a coding write, `expect file path to contain "text"` asks the QA agent to check that snippet. A missing file, an empty file, or a file the security agent removed fails the review. The transcript says which file failed. On that failure, the coding agent writes again through the same path (OpenClaw write bridge when the gateway drove the turn, otherwise the local sandbox) and QA runs again. A failed page claim is checked again the same way. This repeats until QA passes or two retries are used. The transcript then says `fix loop passed on retry N` or `fix budget exhausted after 2 retries`.

```bash
pnpm exec ocp chat --sandbox .sandbox --computer-execute "Open https://example.com and expect title \"Example Domain\""
```

You can also send one message and return:

```bash
pnpm exec ocp chat --sandbox .sandbox "Use Grok Build to create hello.txt with content:
hello
"
```

When the OpenClaw gateway is up, it owns the session plan on `agent:board:main`. The chat agent sends that plan with `sessions.send` and checks `skills.status` on that session. The local swarm does not run a second plan. If the gateway rejects the plan, the turn stops and no worker writes files. When the gateway is down, the transcript prints a manager plan from the local manager before any worker runs, and a create-file is a local sandbox write. The transcript says `Write path: local sandbox.`

After the plan is accepted, this process starts a loopback write bridge and asks the gateway to invoke `ocp_sandbox_write`, `ocp_sandbox_delete`, or `ocp_sandbox_rename`. The gateway calls that bridge. The bridge runs the security gate, then writes, deletes, or renames the sandbox file. The transcript says `Write path: OpenClaw-driven.`, `Delete path: OpenClaw-driven.`, or `Rename path: OpenClaw-driven.` A general edit is drafted in a temp directory by LiteLLM, the OpenAI-compatible meter, or Grok Build, then each kept file is sent through that same bridge. The meter order is unchanged. `fs_write`, `apply_patch`, and `sessions_spawn` stay blocked. If the bridge tool is missing on the gateway, the turn asks the built-in `write` tool for an absolute path in the sandbox. If that also refuses, the file does not land and this process does not copy it in. `pnpm demo:connected` checks the gateway and the meter. It does not itself write a sandbox file. Do not commit `XAI_API_KEY`, `OPENAI_API_KEY`, or `OPENCLAW_GATEWAY_TOKEN`.

Live check when you have a gateway and a meter key. Tests do not call a live gateway. Load `integrations/openclaw-sandbox-write` in the gateway, then:

```bash
docker compose up -d openclaw-gateway
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export LITELLM_API_KEY="the operator key"
pnpm exec ocp chat --sandbox .sandbox "add a README section explaining install"
```

The sandbox file should exist, and the transcript should say `Write path: OpenClaw-driven.` If the plugin is not loaded, the same command still tries the built-in `write` tool. A missing file means that tool refused the path.

Open the multi-file proof without a key: [examples/proof-multifile/src/math.ts](examples/proof-multifile/src/math.ts) and [examples/proof-multifile/src/math.test.ts](examples/proof-multifile/src/math.test.ts). With a meter key, this writes those files into `.sandbox-proof/`:

```bash
pnpm proof:coding
```

Native Grok:

```bash
pnpm bundle:install
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export XAI_API_KEY="the operator key"
docker compose up -d openclaw-gateway
pnpm exec ocp chat --sandbox .sandbox
```

OpenAI-compatible meter (LiteLLM or OpenRouter). `OPENAI_MODEL` is optional and defaults to `gpt-4o-mini`:

```bash
export OPENAI_API_KEY="the operator key"
export OPENAI_BASE_URL="https://your-litellm-or-openrouter/v1"
pnpm exec ocp chat --sandbox .sandbox
```

## Demo

```bash
pnpm install
pnpm test
pnpm exec ocp demo --sandbox .sandbox
pnpm exec opencodingpartner demo --sandbox .sandbox
pnpm demo:connected
```

`ocp demo --live` is the same command as `pnpm demo:connected`. It tries a real chat turn on the OpenClaw gateway and a real coding/QA call through the bundled `grok` binary. The report says what ran and what was skipped.

Set these in your shell. Do not commit them.

```bash
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export XAI_API_KEY="the operator key"
docker compose up -d openclaw-gateway
pnpm demo:connected
```

Or point the coding meter at LiteLLM:

```bash
export LITELLM_API_KEY="the operator key"
export LITELLM_BASE_URL="https://your-litellm.example/v1"
```

`OPENAI_API_KEY` plus `OPENAI_BASE_URL` still works when no LiteLLM key is set. OpenRouter fits that pair.

If the gateway is down, the chat turn is skipped. If no LiteLLM key, OpenAI pair, or `XAI_API_KEY` is set, the coding call is skipped. The offline demo still works without the bundle.

The demo stands up a coding agent, a QA agent, a security agent, and a computer agent. The coding agent writes `PRODUCT.md` in the sandbox. The QA agent checks that file. The security agent blocks a path escape and a secret. The computer agent writes `gtm/action-plan.json`. Every computer action is marked not executed. No live browser ran.

## Credits

| Piece | License | Credit |
| --- | --- | --- |
| OpenClaw | MIT | OpenClaw Foundation — https://github.com/openclaw/openclaw |
| Grok Build | Apache-2.0 | xAI (SpaceXAI) — https://github.com/xai-org/grok-build |
| Laya | Apache-2.0 | Convai Innovations — https://pypi.org/project/laya/ and https://huggingface.co/convaiinnovations/laya |
| LiteLLM | MIT | BerriAI — https://github.com/BerriAI/litellm |
| OpenCodingPartner | Apache-2.0 | OpenCodingPartner contributors |

Full wording is in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Independence

We package and connect these tools for the operator. We are not affiliated with OpenClaw, xAI, SpaceXAI, or Convai Innovations. The offline demo still uses a local sandbox. System-1 uses the Laya install from `pnpm bundle:install` (or `pnpm bundle:install:laya`) and says fallback when that Python is missing. The computer agent does not run a browser unless you pass `--computer-execute`. OpenClaw owns the session plan. A create-file after that plan uses the gateway `write` tool. General model edits still run in this process. Laya weights download into `.bundle/laya/hf` and are not committed.
