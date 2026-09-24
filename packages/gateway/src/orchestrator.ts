import { randomUUID } from "node:crypto";
import path from "node:path";

import { ConversationManager, DeterministicCodingManager, type Manager } from "@opencodingpartner/managers";
import {
  FOUNDATION_LIMITS,
  isInsideSandbox,
  type CodingWorkerId,
  type ManagerPlan,
  type PolicyPrediction,
  type TraceEvent,
  type TurnResult,
  type WorkerResult,
} from "@opencodingpartner/mesh";
import {
  MESH_ROUTE_QUESTIONS,
  MockLayaPolicyRouter,
  evaluateRoute,
  type PolicyRouter,
  type RouteDecision,
} from "@opencodingpartner/policy";
import {
  GrokBuildCodingWorker,
  LocalSandboxWorker,
  type CodingWorker,
} from "@opencodingpartner/workers";

import { resolveBinding } from "./bindings.js";
import { BOARD_DEMO_KEYS, BOARD_DEMO_MESSAGES } from "./board-demo.js";
import { SessionStore } from "./session-store.js";

export interface OrchestratorDeps {
  readonly policy: PolicyRouter;
  readonly managers: ReadonlyMap<Manager["id"], Manager>;
  readonly workers: ReadonlyMap<CodingWorkerId, CodingWorker>;
  readonly sessions: SessionStore;
  readonly sandboxRoot: string;
  readonly sessionKey: string;
  readonly channel: string;
  readonly accountId: string;
  readonly agentId: string;
}

export interface FoundationOptions {
  readonly sandboxRoot: string;
  readonly sessionKey?: string;
  readonly policy?: PolicyRouter;
  readonly managers?: ReadonlyMap<Manager["id"], Manager>;
  readonly workers?: ReadonlyMap<CodingWorkerId, CodingWorker>;
}

interface FinishInput {
  readonly ok: boolean;
  readonly message: string;
  readonly idempotencyKey: string;
  readonly turnId: string;
  readonly reply: string;
  readonly disposition: string;
  readonly dispatched: boolean;
  readonly filesChanged: readonly string[];
  readonly prediction: PolicyPrediction;
  readonly plan: ManagerPlan | null;
  readonly workerResult: WorkerResult | null;
  readonly trace: TraceEvent[];
  readonly error?: string;
}

function controlReply(decision: RouteDecision): string {
  if (decision.kind === "decline") {
    return "Declined before a manager planned work. This mesh does not move money and does not run advertisements.";
  }
  if (decision.kind === "clarify") {
    return "No worker ran. Name the file and the bytes: create RELATIVE_PATH with content:";
  }
  return `Stopped before a worker ran. ${decision.blockReason ?? "The route was blocked."}`;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  handleTurn(message: string, options?: { readonly idempotencyKey?: string }): Promise<TurnResult> {
    const idempotencyKey = options?.idempotencyKey ?? randomUUID();
    return this.deps.sessions.runExclusive(this.deps.sessionKey, () => this.runTurn(message, idempotencyKey));
  }

  async preview(message: string): Promise<{ readonly prediction: PolicyPrediction; readonly decision: RouteDecision }> {
    const prediction = await this.deps.policy.predict(this.state(message), MESH_ROUTE_QUESTIONS);
    return { prediction, decision: evaluateRoute(prediction) };
  }

  private state(message: string) {
    return {
      channel: this.deps.channel,
      accountId: this.deps.accountId,
      sessionKey: this.deps.sessionKey,
      agentId: this.deps.agentId,
      message,
    };
  }

  private async runTurn(message: string, idempotencyKey: string): Promise<TurnResult> {
    const stored = this.deps.sessions.get(this.deps.sessionKey, idempotencyKey);
    if (stored !== undefined) {
      return { ...stored, replayed: true };
    }

    const trace: TraceEvent[] = [];
    const turnId = `turn-${this.deps.sessions.allocateTurn(this.deps.sessionKey)}`;
    trace.push({
      type: "session.resolved",
      sessionKey: this.deps.sessionKey,
      channel: this.deps.channel,
      agentId: this.deps.agentId,
    });

    const prediction = await this.deps.policy.predict(this.state(message), MESH_ROUTE_QUESTIONS);
    trace.push({
      type: "policy.predicted",
      backend: prediction.routing.backend,
      model: prediction.routing.model,
      disposition: prediction.answers.disposition.choice,
      manager: prediction.answers.manager.choice,
      worker: prediction.answers.worker.choice,
      needsHuman: prediction.answers.needs_human.noul,
    });

    const decision = evaluateRoute(prediction);
    if (decision.kind === "blocked" || decision.kind === "decline" || decision.kind === "clarify") {
      if (decision.kind === "blocked") {
        trace.push({ type: "control.blocked", reason: decision.blockReason ?? "blocked" });
      } else {
        trace.push({ type: "worker.skipped", reason: decision.kind });
      }
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: controlReply(decision),
        disposition: decision.kind,
        dispatched: false,
        filesChanged: [],
        prediction,
        plan: null,
        workerResult: null,
        trace,
      });
    }

    if (decision.kind === "answer") {
      return this.answer(message, idempotencyKey, turnId, prediction, trace);
    }

    return this.dispatch(message, idempotencyKey, turnId, prediction, trace);
  }

  private answer(
    message: string,
    idempotencyKey: string,
    turnId: string,
    prediction: PolicyPrediction,
    trace: TraceEvent[],
  ): TurnResult {
    const manager = this.deps.managers.get("conversation-manager");
    if (manager === undefined) {
      return this.finish({
        ok: false,
        message,
        idempotencyKey,
        turnId,
        reply: "Conversation manager is not registered.",
        disposition: "answer",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan: null,
        workerResult: null,
        trace,
        error: "conversation manager is not registered",
      });
    }
    const plan = manager.plan({ message, sessionKey: this.deps.sessionKey, policy: prediction });
    trace.push({
      type: "manager.planned",
      managerId: manager.id,
      dispatch: plan.dispatch,
      taskCount: plan.tasks.length,
    });
    if (plan.dispatch || plan.tasks.length !== 0) {
      trace.push({ type: "control.blocked", reason: "conversation manager tried to dispatch" });
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: "Stopped. The conversation manager cannot dispatch a worker.",
        disposition: "blocked",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
      });
    }
    trace.push({ type: "worker.skipped", reason: "answer turn has no worker" });
    return this.finish({
      ok: true,
      message,
      idempotencyKey,
      turnId,
      reply: plan.reply,
      disposition: "answer",
      dispatched: false,
      filesChanged: [],
      prediction,
      plan,
      workerResult: null,
      trace,
    });
  }

  private async dispatch(
    message: string,
    idempotencyKey: string,
    turnId: string,
    prediction: PolicyPrediction,
    trace: TraceEvent[],
  ): Promise<TurnResult> {
    const manager = this.deps.managers.get("coding-manager");
    if (manager === undefined) {
      return this.finish({
        ok: false,
        message,
        idempotencyKey,
        turnId,
        reply: "Coding manager is not registered.",
        disposition: "dispatch",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan: null,
        workerResult: null,
        trace,
        error: "coding manager is not registered",
      });
    }

    const plan = manager.plan({ message, sessionKey: this.deps.sessionKey, policy: prediction });
    trace.push({
      type: "manager.planned",
      managerId: manager.id,
      dispatch: plan.dispatch,
      taskCount: plan.tasks.length,
    });
    const task = plan.tasks[0];
    if (!plan.dispatch || task === undefined) {
      trace.push({ type: "worker.skipped", reason: plan.reply });
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: plan.reply,
        disposition: "dispatch",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
      });
    }
    if (plan.tasks.length !== FOUNDATION_LIMITS.maxWorkersPerTurn) {
      trace.push({ type: "control.blocked", reason: "speculative swarm is off" });
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: "Stopped. A turn can dispatch one worker.",
        disposition: "blocked",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
      });
    }

    const workerId = prediction.answers.worker.choice;
    if (workerId !== "local-sandbox" && workerId !== "grok-build") {
      trace.push({ type: "control.blocked", reason: "route did not name a coding worker" });
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: "Stopped. The route did not name a coding worker.",
        disposition: "blocked",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
      });
    }

    const worker = this.deps.workers.get(workerId);
    if (worker === undefined) {
      trace.push({ type: "control.blocked", reason: `${workerId} is not registered` });
      return this.finish({
        ok: false,
        message,
        idempotencyKey,
        turnId,
        reply: `${workerId} is not registered.`,
        disposition: "dispatch",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
        error: `${workerId} is not registered`,
      });
    }

    trace.push({ type: "worker.dispatched", workerId: worker.id, taskId: task.id });
    try {
      const workerResult = await worker.dispatch({
        sessionKey: this.deps.sessionKey,
        turnId,
        idempotencyKey,
        sandboxRoot: this.deps.sandboxRoot,
        task,
      });
      if (
        workerResult.location.kind === "sandbox" &&
        !isInsideSandbox(this.deps.sandboxRoot, workerResult.location.absolutePath)
      ) {
        trace.push({ type: "control.blocked", reason: "worker result escaped the sandbox" });
        return this.finish({
          ok: false,
          message,
          idempotencyKey,
          turnId,
          reply: "Stopped. The worker result left the sandbox.",
          disposition: "dispatch",
          dispatched: false,
          filesChanged: [],
          prediction,
          plan,
          workerResult,
          trace,
          error: "worker result escaped the sandbox",
        });
      }
      trace.push({
        type: "worker.finished",
        workerId: worker.id,
        relativePath: workerResult.relativePath,
        bytesWritten: workerResult.bytesWritten,
      });
      const filesChanged = workerResult.location.kind === "sandbox" ? [workerResult.relativePath] : [];
      return this.finish({
        ok: true,
        message,
        idempotencyKey,
        turnId,
        reply: `Wrote ${workerResult.relativePath} (${workerResult.bytesWritten} bytes) via ${worker.id}.`,
        disposition: "dispatch",
        dispatched: true,
        filesChanged,
        prediction,
        plan,
        workerResult,
        trace,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "worker failed";
      return this.finish({
        ok: false,
        message,
        idempotencyKey,
        turnId,
        reply: errorMessage,
        disposition: "dispatch",
        dispatched: false,
        filesChanged: [],
        prediction,
        plan,
        workerResult: null,
        trace,
        error: errorMessage,
      });
    }
  }

  private finish(input: FinishInput): TurnResult {
    const trace: TraceEvent[] = [
      ...input.trace,
      {
        type: "turn.completed",
        disposition: input.disposition,
        dispatched: input.dispatched,
        ok: input.ok,
      },
    ];
    const result: TurnResult = {
      ok: input.ok,
      replayed: false,
      sessionKey: this.deps.sessionKey,
      turnId: input.turnId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      reply: input.reply,
      disposition: input.disposition,
      dispatched: input.dispatched,
      filesChanged: input.filesChanged,
      prediction: input.prediction,
      plan: input.plan,
      workerResult: input.workerResult,
      trace,
      limits: FOUNDATION_LIMITS,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    if (result.ok) {
      this.deps.sessions.put(this.deps.sessionKey, result);
    }
    return result;
  }
}

function defaultManagers(): Map<Manager["id"], Manager> {
  return new Map<Manager["id"], Manager>([
    ["coding-manager", new DeterministicCodingManager()],
    ["conversation-manager", new ConversationManager()],
  ]);
}

function defaultWorkers(): Map<CodingWorkerId, CodingWorker> {
  return new Map<CodingWorkerId, CodingWorker>([
    ["local-sandbox", new LocalSandboxWorker()],
    ["grok-build", new GrokBuildCodingWorker()],
  ]);
}

export function createFoundationMesh(options: FoundationOptions): Orchestrator {
  const binding = resolveBinding("cli", "local");
  return new Orchestrator({
    policy: options.policy ?? new MockLayaPolicyRouter(),
    managers: options.managers ?? defaultManagers(),
    workers: options.workers ?? defaultWorkers(),
    sessions: new SessionStore(),
    sandboxRoot: path.resolve(options.sandboxRoot),
    sessionKey: options.sessionKey ?? binding.sessionKey,
    channel: binding.channel,
    accountId: binding.accountId,
    agentId: binding.agentId,
  });
}

export async function runBoardDemo(orchestrator: Orchestrator): Promise<readonly [TurnResult, TurnResult]> {
  const status = await orchestrator.handleTurn(BOARD_DEMO_MESSAGES.status, {
    idempotencyKey: BOARD_DEMO_KEYS.status,
  });
  const write = await orchestrator.handleTurn(BOARD_DEMO_MESSAGES.write, {
    idempotencyKey: BOARD_DEMO_KEYS.write,
  });
  return [status, write];
}
