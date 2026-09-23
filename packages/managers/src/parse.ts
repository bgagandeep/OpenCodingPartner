import {
  FOUNDATION_LIMITS,
  PathRejectedError,
  sanitizeRelativePath,
  type ManagerPlan,
  type WorkerTask,
} from "@opencodingpartner/mesh";

export class PlanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRejectedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanRejectedError(`${key} must be a non-empty string`);
  }
  return value;
}

function parseTask(value: unknown, index: number): WorkerTask {
  if (!isRecord(value)) {
    throw new PlanRejectedError(`task ${index} must be an object`);
  }
  if (value["kind"] !== "write_file") {
    throw new PlanRejectedError(`task ${index} must be a write_file task`);
  }
  const relativePath = requiredString(value, "relativePath");
  try {
    sanitizeRelativePath(relativePath);
  } catch (error) {
    if (error instanceof PathRejectedError) {
      throw new PlanRejectedError(error.message);
    }
    throw error;
  }
  const contents = value["contents"];
  if (typeof contents !== "string" || contents.trim().length === 0) {
    throw new PlanRejectedError(`task ${index} needs file contents`);
  }
  return {
    id: requiredString(value, "id"),
    kind: "write_file",
    relativePath: sanitizeRelativePath(relativePath),
    contents,
    rationale: requiredString(value, "rationale"),
  };
}

export function parseManagerPlan(value: unknown): ManagerPlan {
  if (!isRecord(value)) {
    throw new PlanRejectedError("manager plan must be an object");
  }
  const managerId = value["managerId"];
  if (managerId !== "coding-manager" && managerId !== "conversation-manager") {
    throw new PlanRejectedError("managerId must be a real manager");
  }
  const dispatch = value["dispatch"];
  if (typeof dispatch !== "boolean") {
    throw new PlanRejectedError("dispatch must be boolean");
  }
  const tasksValue = value["tasks"];
  if (!Array.isArray(tasksValue)) {
    throw new PlanRejectedError("tasks must be an array");
  }
  if (tasksValue.length > FOUNDATION_LIMITS.maxWorkersPerTurn) {
    throw new PlanRejectedError(
      `speculative swarm is off; a plan may contain at most ${FOUNDATION_LIMITS.maxWorkersPerTurn} task`,
    );
  }
  if (dispatch && tasksValue.length !== 1) {
    throw new PlanRejectedError("a dispatch plan contains exactly one task");
  }
  if (!dispatch && tasksValue.length !== 0) {
    throw new PlanRejectedError("a plan that does not dispatch contains no tasks");
  }
  const tasks = tasksValue.map((task, index) => parseTask(task, index));
  return {
    managerId,
    goal: requiredString(value, "goal"),
    reply: requiredString(value, "reply"),
    dispatch,
    tasks,
  };
}
