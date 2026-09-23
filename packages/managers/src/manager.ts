import type { ManagerPlan, PolicyPrediction } from "@opencodingpartner/mesh";

export interface ManagerInput {
  readonly message: string;
  readonly sessionKey: string;
  readonly policy: PolicyPrediction;
}

export interface Manager {
  readonly id: "coding-manager" | "conversation-manager";
  plan(input: ManagerInput): ManagerPlan;
}
