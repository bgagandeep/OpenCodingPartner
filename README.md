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

We cite those projects. We do not vendor them. See [Independence](#independence).

## Demo

```bash
pnpm install
pnpm test
pnpm exec ocp demo --sandbox .sandbox
pnpm exec opencodingpartner demo --sandbox .sandbox
```

The demo stands up a coding agent, a QA agent, a security agent, and a computer agent. The coding agent writes `PRODUCT.md` in the sandbox. The QA agent checks that file. The security agent blocks a path escape and a secret. The computer agent writes `gtm/action-plan.json`. Every computer action is marked not executed. No live browser ran.

## License

Apache-2.0. See [LICENSE](LICENSE). Grok Build and Laya use Apache-2.0, and this license includes a patent grant. OpenClaw is MIT. We do not copy its code into this repo.

## Independence

We do not ship OpenClaw, Grok Build, or Laya. The operator installs them. This project is not affiliated with those projects, with xAI, or with Convai Innovations. The offline demo uses a local sandbox and a mock System-1 router so you can run it without those installs.
