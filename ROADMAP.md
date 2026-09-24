# Roadmap

The finish line for this sequence is a Board UAT of the mesh, with every runtime either real or visibly unwired. Dates are not the plan. The order is.

## 1. Foundation (this tree)

- Contracts for a Laya-shaped route, a manager plan, and one coding worker.
- In-process session lane and the CLI binding `agent:board:main`.
- Mock policy router, deterministic managers, local sandbox worker that writes a real file.
- Grok Build request builder with an injected runner. The local sandbox worker is the offline runtime.
- Offline tests, including the CLI demo.
- Apache-2.0 core. Enterprise pack is a stub page.

## 2. Loopback gateway daemon

Replace the in-process call with a long-lived gateway on loopback, following the OpenClaw control-plane shape: one process owns sessions, clients send a turn, the process emits the trace. Session history survives a restart. The turn order in [ARCHITECTURE.md](ARCHITECTURE.md) stays put.

## 3. Operator-loaded Laya

`LayaCheckpointRouter` talks to `integrations/laya/predict.py` when the operator has installed `laya` and accepts the Hub download of `convaiinnovations/laya` (421M, English route questions). The mock router remains the default so a clean checkout still runs offline. The gateway keeps `evaluateRoute` in front of the worker.

## 4. Chat-model manager

A manager implementation that sends the route and the operator message to a chat model the operator configures, and accepts only JSON that `parseManagerPlan` allows. The model does not receive a tool that writes files. The worker remains the only writer.

## 5. Grok Build worker

An opt-in runner that spawns the operator's `grok` binary with the argv `buildGrokHeadlessInvocation` already builds, then maps the streaming-json result back onto `WorkerResult`. No spawn unless that runner is selected.

## 6. Board UAT

A scripted set of turns on the Board session, reviewed from the trace rather than from a chat scroll:

- Status turn writes nothing.
- Create-file turn writes the named sandbox file and no other file.
- Payment and advertisement wording stops before a worker.
- A path that escapes the sandbox stops before a write.
- A route with `needs_human` at or above 0.5 stops before a write.
- Grok Build stays quiet unless that scenario injects a runner.
- Replay of an idempotency key does not write twice.

UAT passes when those traces match, on the daemon from phase 2, with Laya and one external worker available to turn on. The local sandbox worker remains a valid worker for air-gapped review.

## 7. Consult and enterprise packs

Still a stub (`packs/enterprise/README.md`). Any future pack is optional to the core, documents its own terms, and is not required to run the mesh. The core stays free of advertisements and of any OpenCodingPartner payment flow.
