# Contributing

Open Coding Partner is Apache-2.0. See [LICENSE](LICENSE).

```bash
pnpm install
pnpm test
pnpm exec ocp demo --sandbox .sandbox
pnpm bundle:plan
pnpm demo:connected
```

`pnpm bundle:install` downloads the connected stack and the System-1 English weights into `.bundle/`. Do not commit that directory. Do not paste that source or those weights into this repo. Keep upstream names and licenses in `THIRD_PARTY_NOTICES.md`.

You need Node 22.14 or newer.

Write plain short sentences in docs. Say chat agent, orchestration agent swarm, coding agent, QA agent, computer agent, and security agent.

Multi-agent is the product. Do not turn the product into a one-worker tool. The temporary early-test cap may stay only if the docs still call it temporary.

Do not vendor the connected stack. Cite the real upstreams only in `THIRD_PARTY_NOTICES.md` and Credits. Do not claim a partnership.

Ads are off. Payments are off in the core. Do not add payment code to the core. A billing key in settings stays inert. The core stays open.

The computer-agent stub must not claim a live browser ran. Mark recorded actions as not executed until a real worker runs them.

The offline tests must keep passing: chat, stand up agents, coding write, QA check, security gate, and a recorded GTM plan.
