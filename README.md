# OpenCodingPartner

OpenCodingPartner is an agentic coding tool. You talk to a chat agent. That chat agent runs an orchestration agent swarm. You ask the swarm to stand up agents.

A coding agent and a QA agent build and test the product. A computer agent helps sell it. A security agent checks the work inside the same coding setup.

A company with enough model hosting can replace day-to-day coding-team build, review, and ship work. This does not cover legal, spend, or brand. A startup can use it to bring an idea to life and to help sell that idea.

The core is free forever and open source. The operator owns the meter. Consult and enterprise help can come later. Ads are off. Payments are off in the core.

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

A general request, such as "Add an add function in src/math.ts and a test in src/math.test.ts", is sent to the coding agent with the sandbox as the working directory. The QA agent then reviews the files that changed. The security agent checks the request first, and checks the written files after. A file that escapes the sandbox or contains a secret is removed.

That general path needs a meter. Use native Grok with `XAI_API_KEY` and the `grok` binary, or an OpenAI-compatible meter with `OPENAI_API_KEY` and `OPENAI_BASE_URL` (LiteLLM or OpenRouter). Without a key, the chat agent says so. It does not pretend the offline sandbox can do open-ended edits.

When Laya is installed (`pnpm bundle:install`, or `OCP_LAYA_PYTHON`), the chat turn calls `integrations/laya/predict.py` and the transcript says `System-1: real Laya.` A machine that only has system Python is not treated as Laya. The transcript then says `System-1: fallback. Laya is not installed.`

This simple message still writes a file on the local sandbox worker:

```text
Use Grok Build to create hello.txt with content:
hello
```

The security agent blocks a path that escapes the sandbox, and it blocks secrets. The QA agent checks the file that was written. The computer agent writes `gtm/action-plan.json`. Every computer action stays `executed: false`. `--computer-execute` records that you asked to run those actions. It still does not claim a live browser ran.

You can also send one message and return:

```bash
pnpm exec ocp chat --sandbox .sandbox "Use Grok Build to create hello.txt with content:
hello
"
```

When the OpenClaw gateway is up, it owns the session plan on `agent:board:main`. The chat agent sends that plan with `sessions.send` and checks `skills.status` on that session. The local swarm does not run a second plan. If the gateway rejects the plan, the turn stops and no worker writes files. When the gateway is down, the transcript prints a manager plan from the local manager before any worker runs. OpenClaw does not write sandbox files. The gateway blocks remote `fs_write` and `sessions_spawn`. After the plan is accepted, Grok Build or the OpenAI-compatible meter writes files from this process. If no key is set, only a simple create-file message is written locally. Do not commit `XAI_API_KEY`, `OPENAI_API_KEY`, or `OPENCLAW_GATEWAY_TOKEN`.

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

Or point the coding meter at LiteLLM or OpenRouter:

```bash
export OPENAI_API_KEY="the operator key"
export OPENAI_BASE_URL="https://your-litellm-or-openrouter/v1"
```

If the gateway is down, the chat turn is skipped. If neither `XAI_API_KEY` nor the OpenAI pair is set, the Grok Build call is skipped. The offline demo still works without the bundle.

The demo stands up a coding agent, a QA agent, a security agent, and a computer agent. The coding agent writes `PRODUCT.md` in the sandbox. The QA agent checks that file. The security agent blocks a path escape and a secret. The computer agent writes `gtm/action-plan.json`. Every computer action is marked not executed. No live browser ran.

## Credits

| Piece | License | Credit |
| --- | --- | --- |
| OpenClaw | MIT | OpenClaw Foundation — https://github.com/openclaw/openclaw |
| Grok Build | Apache-2.0 | xAI (SpaceXAI) — https://github.com/xai-org/grok-build |
| Laya | Apache-2.0 | Convai Innovations — https://pypi.org/project/laya/ and https://huggingface.co/convaiinnovations/laya |
| OpenCodingPartner | Apache-2.0 | OpenCodingPartner contributors |

Full wording is in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Independence

We package and connect these tools for the operator. We are not affiliated with OpenClaw, xAI, SpaceXAI, or Convai Innovations. The offline demo still uses a local sandbox. System-1 uses the Laya install from `pnpm bundle:install` (or `pnpm bundle:install:laya`) and says fallback when that Python is missing. The computer agent does not run a browser. OpenClaw owns the session plan and does not write sandbox files. Laya weights download into `.bundle/laya/hf` and are not committed.
