# OpenCodingPartner

OpenCodingPartner is a free, open-source control plane for agentic coding. One gateway owns the session. A small decision model chooses the lane. A manager writes a bounded plan. One coding worker executes that plan. The operator owns every model credential, weight file, and coding-runtime account.

The repository is private while the Board reviews it. The core is intended to stay free when the project is public. Consult and enterprise packs are a reserved name with no code (`packs/enterprise`).

This foundation runs that control plane on a laptop, offline. It records an honest seam where a chat model, the Laya weights, Grok Build, or Cursor Cloud Agents will sit later. The demo does not pretend those runtimes were called.

## License

Apache-2.0. See [LICENSE](LICENSE).

Apache-2.0 is the fit for three reasons:

- The patent grant matters for an orchestration layer that will sit beside coding runtimes.
- Two upstreams this mesh is built to call are already Apache-2.0: [Grok Build](https://github.com/xai-org/grok-build) and the [Laya](https://pypi.org/project/laya/) package (0.3.7). Staying in that family keeps a later in-process or vendored adapter simpler.
- MIT is shorter and omits the patent grant. That grant is the part we want on the core.

OpenCodingPartner is independent of xAI, Cursor, the OpenClaw project, and Convai Innovations. Citations below are so operators can check the pattern against the real upstream. They are not endorsements, certifications, or a partnership.

## What the core includes

- A session lane and channel binding, the same control-plane idea as the [OpenClaw gateway](https://docs.openclaw.ai/concepts/architecture) and its [multi-agent bindings](https://docs.openclaw.ai/concepts/multi-agent).
- A System-1 policy router shaped like Laya `Router.predict`: typed questions in, typed answers out, no generated prose. The offline build uses a documented heuristic. The real call site is `integrations/laya/predict.py`.
- Managers that emit a `ManagerPlan`. The coding manager plans one file write. It does not invent a diff.
- A coding-worker interface. The local sandbox worker writes a real file. Cursor Cloud Agents v1 and Grok Build are request builders with an injected transport, so the foundation never opens those sockets on its own.
- A CLI, `ocp` (also `opencodingpartner`), that runs the Board demo.

Ads are off. The core does not move money. Speculative fan-out is off: one turn, one worker.

## Run the Board demo

Requires Node.js 22.14 or newer and pnpm 10.

```bash
pnpm install
pnpm test
pnpm demo
```

`pnpm demo` compiles the workspace and runs two turns against `.sandbox/` (gitignored):

1. A status question. The conversation manager answers. No file is written.
2. A create-file instruction. The policy router selects the coding manager and the local sandbox worker. The worker writes `.sandbox/BOARD.md`.

`pnpm install` links both binaries from the workspace root. They are the same program.

```bash
pnpm exec ocp demo --sandbox .sandbox
pnpm exec opencodingpartner run --sandbox .sandbox --message "$(printf 'create notes/hello.txt with content:\nHello from the mesh.\n')"
pnpm exec ocp route --message "Summarize the mesh status for Board review."
```

The compiled entry is the same file the binaries run:

```bash
node packages/cli/dist/main.js demo --sandbox .sandbox
```

A create-file turn uses this grammar, and only this grammar, in the foundation manager:

```text
create RELATIVE_PATH with content:
line one
line two
```

Paths that escape the sandbox are rejected before any write.

## Layout

```text
packages/mesh       shared contracts: Laya answers, plans, limits, trace
packages/policy     route questions, mock router, Laya checkpoint adapter
packages/managers   plan parser and the two foundation managers
packages/workers    local sandbox, Cursor Cloud request, Grok Build argv
packages/gateway    session lane and the only worker dispatch site
packages/cli        ocp / opencodingpartner
integrations/laya   stdin JSON bridge to the real laya package
packs/enterprise    reserved name, no code
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the turn sequence and [ROADMAP.md](ROADMAP.md) for the path to Board UAT.

## Operator-owned meter

The core never ships an API key, a weight file, or a hosted billing meter.

| Runtime | Who pays | How this repo reaches it |
| --- | --- | --- |
| Laya, about 421M parameters | The operator, local weights | `python integrations/laya/predict.py` after `pip install laya` |
| Chat manager | The operator's model account | Later. The contract is `ManagerPlan` JSON |
| Grok Build | The operator's install and account | Argv for `grok -p … --output-format streaming-json` |
| Cursor Cloud Agents | The operator's Cursor key | `POST /v1/agents` body, transport injected by the operator |

## Upstreams

Patterns and APIs this repo follows. Code is not copied from them.

- OpenClaw gateway, sessions, and bindings: <https://github.com/openclaw/openclaw>, <https://docs.openclaw.ai/concepts/agent-loop>
- Grok Build headless and ACP: <https://github.com/xai-org/grok-build>, <https://docs.x.ai/build/overview>
- Cursor Cloud Agents API v1 (durable agent plus runs): <https://cursor.com/docs/cloud-agent/api/endpoints>
- Laya System-1 checkpoints and `Router`: <https://huggingface.co/convaiinnovations/laya>, <https://pypi.org/project/laya/>

## Status of this tree

The control-plane path is executable and tested offline. Chat-model managers, Laya weights, a Grok Build process, and a live Cursor call are named seams, not silent stubs behind a chat window. See [ROADMAP.md](ROADMAP.md).
