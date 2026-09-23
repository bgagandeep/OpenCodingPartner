import type { FoundationLimits } from "./limits.js";
import type { ManagerPlan } from "./plan.js";
import type { PolicyPrediction } from "./laya.js";
import type { TraceEvent } from "./trace.js";
import type { WorkerResult } from "./worker.js";

export interface TurnResult {
  readonly ok: boolean;
  readonly replayed: boolean;
  readonly sessionKey: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly reply: string;
  readonly disposition: string;
  readonly dispatched: boolean;
  readonly filesChanged: readonly string[];
  readonly prediction: PolicyPrediction;
  readonly plan: ManagerPlan | null;
  readonly workerResult: WorkerResult | null;
  readonly trace: readonly TraceEvent[];
  readonly limits: FoundationLimits;
  readonly error?: string;
}
