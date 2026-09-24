import type { CodingDispatch, CodingWorkerId, WorkerResult } from "@opencodingpartner/mesh";

export interface CodingWorker {
  readonly id: CodingWorkerId;
  dispatch(input: CodingDispatch): Promise<WorkerResult>;
}

export class CodingWorkerNotConfiguredError extends Error {
  readonly workerId: CodingWorkerId;

  constructor(workerId: CodingWorkerId, message: string) {
    super(message);
    this.name = "CodingWorkerNotConfiguredError";
    this.workerId = workerId;
  }
}
