import { NEEDS_HUMAN_BLOCK_AT, type PolicyPrediction } from "@opencodingpartner/mesh";

export type RouteKind = "dispatch" | "answer" | "clarify" | "decline" | "blocked";

export interface RouteDecision {
  readonly kind: RouteKind;
  readonly blockReason?: string;
}

function blocked(reason: string): RouteDecision {
  return { kind: "blocked", blockReason: reason };
}

export function evaluateRoute(prediction: PolicyPrediction): RouteDecision {
  const disposition = prediction.answers.disposition.choice;
  const manager = prediction.answers.manager.choice;
  const worker = prediction.answers.worker.choice;
  const needsHuman = prediction.answers.needs_human.noul;

  if (disposition === "decline") {
    if (manager !== "none" || worker !== "none") {
      return blocked("a decline must not name a manager or a worker");
    }
    return { kind: "decline" };
  }

  if (disposition === "clarify") {
    if (worker !== "none") {
      return blocked("a clarify turn must not select a worker");
    }
    return { kind: "clarify" };
  }

  if (disposition === "answer") {
    if (manager !== "conversation-manager" || worker !== "none") {
      return blocked("an answer turn stays on the conversation manager with no worker");
    }
    return { kind: "answer" };
  }

  if (disposition === "dispatch") {
    if (manager !== "coding-manager") {
      return blocked("a dispatch turn requires the coding manager");
    }
    if (worker === "none") {
      return blocked("a dispatch turn requires a coding worker");
    }
    if (needsHuman >= NEEDS_HUMAN_BLOCK_AT) {
      return blocked(`needs_human ${needsHuman} is at or above ${NEEDS_HUMAN_BLOCK_AT}`);
    }
    return { kind: "dispatch" };
  }

  return blocked(`unknown disposition: ${disposition}`);
}
