import type { WorkerTask } from "./plan.js";

export interface CodingDispatch {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly sandboxRoot: string;
  readonly task: WorkerTask;
}

export type WorkerLocation =
  | { readonly kind: "sandbox"; readonly absolutePath: string }
  | { readonly kind: "external"; readonly reference: string };

export interface WorkerResult {
  readonly workerId: string;
  readonly relativePath: string;
  readonly bytesWritten: number;
  readonly location: WorkerLocation;
}
