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

That one command installs pinned OpenClaw, Grok Build, and Laya under `.bundle/`. It uses npm and pip. It does not copy their source trees into this repo. Upstream license files stay inside those installs.

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

A general request, such as "add a README section explaining install", is sent to Grok Build with the sandbox as the working directory. The QA agent then reviews the files that changed. The security agent checks the request first, and checks the written files after. A file that escapes the sandbox or contains a secret is removed.

That general path needs `XAI_API_KEY` and the `grok` binary. Without them, the chat agent says so. It does not pretend the offline sandbox can do open-ended edits.

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

When the OpenClaw gateway is up, the same chat turn is also sent to session `agent:board:main`. The local swarm still coordinates the roles. When `XAI_API_KEY` is set and the bundled `grok` binary is installed, the coding agent passes your message to Grok Build and lets it edit the sandbox. If the gateway is down, that notify step is skipped. If the key is missing, only a simple create-file message is written locally. Do not commit `XAI_API_KEY` or `OPENCLAW_GATEWAY_TOKEN`.

```bash
pnpm bundle:install
export OPENCLAW_GATEWAY_TOKEN="the gateway token"
export XAI_API_KEY="the operator key"
docker compose up -d openclaw-gateway
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

If the gateway is down, the chat turn is skipped. If `XAI_API_KEY` is unset, the Grok Build call is skipped. The offline demo still works without the bundle.

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

We package and connect these tools for the operator. We are not affiliated with OpenClaw, xAI, SpaceXAI, or Convai Innovations. The offline demo still uses a local sandbox and a mock System-1 router when those tools are not installed.
