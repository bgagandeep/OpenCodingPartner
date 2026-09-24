import { parseCreateFileInstruction, type Disposition, type ManagerId, type WorkerId } from "@opencodingpartner/mesh";

const PAYMENT_OR_ADS =
  /\b(payment|payments|checkout|credit card|advertisement|advertisements|buy now|stripe)\b/i;
const STATUS = /\b(summarize|summary|status|what is the mesh|do not edit)\b/i;

export interface ClassifiedRoute {
  readonly disposition: Disposition;
  readonly manager: ManagerId;
  readonly worker: WorkerId;
  readonly urgencyLevel: number;
  readonly needsHuman: number;
  readonly reason: string;
}

export function classifyMessage(message: string): ClassifiedRoute {
  if (PAYMENT_OR_ADS.test(message)) {
    return {
      disposition: "decline",
      manager: "none",
      worker: "none",
      urgencyLevel: 0,
      needsHuman: 0.93,
      reason: "the message asks for payments or advertisements, which this mesh does not run",
    };
  }

  const instruction = parseCreateFileInstruction(message);
  if (instruction !== null) {
    const worker: WorkerId = instruction.runtimeHint;
    return {
      disposition: "dispatch",
      manager: "coding-manager",
      worker,
      urgencyLevel: /\bboard\b/i.test(message) ? 2 : 1,
      needsHuman: 0.08,
      reason: `create-file task routed to ${worker}`,
    };
  }

  const trimmed = message.trim();
  if (STATUS.test(trimmed)) {
    return {
      disposition: "answer",
      manager: "conversation-manager",
      worker: "none",
      urgencyLevel: 1,
      needsHuman: 0.12,
      reason: "status question stays with the conversation manager",
    };
  }

  return {
    disposition: "clarify",
    manager: "none",
    worker: "none",
    urgencyLevel: 0,
    needsHuman: 0.81,
    reason: "no concrete file task, so the control plane will not guess a diff",
  };
}
