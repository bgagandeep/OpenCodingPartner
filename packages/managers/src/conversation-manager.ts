import { FOUNDATION_LIMITS } from "@opencodingpartner/mesh";

import type { Manager, ManagerInput } from "./manager.js";
import { parseManagerPlan } from "./parse.js";

export class ConversationManager implements Manager {
  readonly id = "conversation-manager" as const;

  plan(_input: ManagerInput): ReturnType<Manager["plan"]> {
    return parseManagerPlan({
      managerId: "conversation-manager",
      goal: "Report mesh status without a coding worker.",
      reply: [
        "Mesh status for this turn:",
        "- System-1 router selects the lane. This build answers with a mock heuristic until the operator loads Laya weights.",
        "- The coding manager plans file tasks. This turn did not ask for one.",
        "- Local sandbox is the configured worker. Cursor Cloud and Grok Build stay unwired until the operator injects a transport.",
        `- Speculative swarm: ${FOUNDATION_LIMITS.speculativeSwarm}. Maximum workers on a turn: ${FOUNDATION_LIMITS.maxWorkersPerTurn}.`,
        `- Ads: ${FOUNDATION_LIMITS.ads}. Payments: ${FOUNDATION_LIMITS.payments}.`,
        "No worker was dispatched.",
      ].join("\n"),
      dispatch: false,
      tasks: [],
    });
  }
}
