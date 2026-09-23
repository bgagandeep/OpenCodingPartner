# Contributing

OpenCodingPartner is Apache-2.0. A contribution submitted to this repository is licensed under the same terms, as in section 5 of [LICENSE](LICENSE).

The Board is the first operator of this tree. Changes should keep the control plane reviewable: a reader can point at the turn and see who decided, who planned, and who wrote bytes.

## Setup

Node.js 22.14 or newer, pnpm 10.

```bash
pnpm install
pnpm test
pnpm demo
```

`pnpm test` typechecks the workspace, then runs the offline suite. The suite does not download weights and does not call Cursor or Grok Build.

## What belongs in the core

- Session, policy, manager plan, and a single worker dispatch.
- Adapters whose network or process edge is explicit and off unless the operator injects it.
- Tests that fail when a turn writes a file the policy did not dispatch.

## What stays out of the core

- Advertisements.
- Any integration that charges a card, opens a checkout, or meters usage for OpenCodingPartner itself. Operators already pay their own model and runtime accounts.
- Claims that xAI, Cursor, OpenClaw, or Convai Innovations ship, certify, or partner on this project.
- A speculative swarm that fans one turn out to several coding runtimes. `FOUNDATION_LIMITS.maxWorkersPerTurn` is 1 until the Board changes that on purpose.
- Vendored weight files. Laya stays behind `integrations/laya/predict.py`.

When you add an adapter, cite the upstream doc in [ARCHITECTURE.md](ARCHITECTURE.md) and add an offline test for the request you would send. Do not add a default client that opens the socket.

## Managers

A manager returns a `ManagerPlan` that `parseManagerPlan` accepts. Prose that is not that object never reaches a worker. The foundation coding manager accepts one grammar (`create RELATIVE_PATH with content:`) so the offline path is deterministic. A later chat-model manager must emit the same object.

## Reviews

Prefer a failing test that names the turn over a comment that describes the turn. Keep package boundaries: `mesh` holds contracts, `policy` decides, `managers` plan, `workers` execute, `gateway` is the only dispatch site.
