import { PathRejectedError, parseCreateFileInstruction, sanitizeRelativePath } from "@opencodingpartner/mesh";

import type { Manager, ManagerInput } from "./manager.js";
import { parseManagerPlan } from "./parse.js";

function idle(reply: string): ReturnType<Manager["plan"]> {
  return parseManagerPlan({
    managerId: "coding-manager",
    goal: "No file task was planned.",
    reply,
    dispatch: false,
    tasks: [],
  });
}

export class DeterministicCodingManager implements Manager {
  readonly id = "coding-manager" as const;

  plan(input: ManagerInput): ReturnType<Manager["plan"]> {
    const instruction = parseCreateFileInstruction(input.message);
    if (instruction === null) {
      return idle("The coding manager did not invent a diff. Use: create RELATIVE_PATH with content:");
    }
    const { relativePath, contents } = instruction;
    if (contents.trim().length === 0) {
      return idle("The coding manager refused an empty file.");
    }
    try {
      const safePath = sanitizeRelativePath(relativePath);
      return parseManagerPlan({
        managerId: "coding-manager",
        goal: `Write ${safePath} in the sandbox.`,
        reply: `Planned one write to ${safePath}.`,
        dispatch: true,
        tasks: [
          {
            id: `write:${safePath}`,
            kind: "write_file",
            relativePath: safePath,
            contents,
            rationale: "The operator named the path and the bytes. The manager does not widen the task.",
          },
        ],
      });
    } catch (error) {
      if (error instanceof PathRejectedError) {
        return idle(error.message);
      }
      throw error;
    }
  }
}
