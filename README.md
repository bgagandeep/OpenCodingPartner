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

## Demo

```bash
pnpm install
pnpm test
pnpm exec ocp demo --sandbox .sandbox
pnpm exec opencodingpartner demo --sandbox .sandbox
pnpm demo:connected
```

`ocp demo --live` is the same connected check as `pnpm demo:connected`. If OpenClaw or Grok Build is missing, it skips and says to run `pnpm bundle:install`. It does not pretend the live tools ran.

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
