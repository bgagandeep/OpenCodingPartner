export const MANAGER_IDS = ["coding-manager", "conversation-manager", "none"] as const;
export type ManagerId = (typeof MANAGER_IDS)[number];

export const WORKER_IDS = ["local-sandbox", "cursor-cloud", "grok-build", "none"] as const;
export type WorkerId = (typeof WORKER_IDS)[number];
export type CodingWorkerId = Exclude<WorkerId, "none">;

export const DISPOSITIONS = ["dispatch", "answer", "clarify", "decline"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface WorkerTask {
  readonly id: string;
  readonly kind: "write_file";
  readonly relativePath: string;
  readonly contents: string;
  readonly rationale: string;
}

export interface ManagerPlan {
  readonly managerId: Exclude<ManagerId, "none">;
  readonly goal: string;
  readonly reply: string;
  readonly dispatch: boolean;
  readonly tasks: readonly WorkerTask[];
}
