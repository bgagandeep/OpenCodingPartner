# Third-party notices

OpenCodingPartner installs these tools for the operator. We do not copy their source into this repo. We are not affiliated with them. Each install keeps that project's own license files.

| Tool | License | Credit | Where it comes from | How we install it |
| --- | --- | --- | --- | --- |
| OpenClaw | MIT | OpenClaw Foundation | https://github.com/openclaw/openclaw | npm package `openclaw@2026.9.6`. Optional image `ghcr.io/openclaw/openclaw:2026.9.6`. |
| Grok Build | Apache-2.0 | xAI (SpaceXAI) | https://github.com/xai-org/grok-build | npm package `@xai-official/grok@1.0.41`, which ships the `grok` binary. |
| Laya | Apache-2.0 | Convai Innovations | https://pypi.org/project/laya/ and https://huggingface.co/convaiinnovations/laya | PyPI package `laya==0.3.13`. Weights download only if you run the bridge. |
| OpenCodingPartner | Apache-2.0 | OpenCodingPartner contributors | This repository | The chat agent, swarm, and installer. |

Pins live in `packages/bundle/pins.json`.
