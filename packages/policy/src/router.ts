import type { PolicyPrediction, PolicyState, QuestionSet } from "@opencodingpartner/mesh";

export interface PolicyRouter {
  predict(state: PolicyState, questions: QuestionSet): Promise<PolicyPrediction>;
}

export interface LayaPredictBridge {
  predict(args: {
    readonly state: PolicyState;
    readonly questions: QuestionSet;
    readonly model: "english" | "multilingual" | "typed-decisions";
  }): Promise<PolicyPrediction>;
}

export class LayaCheckpointRouter implements PolicyRouter {
  constructor(
    private readonly bridge: LayaPredictBridge,
    private readonly model: "english" | "multilingual" | "typed-decisions" = "english",
  ) {}

  async predict(state: PolicyState, questions: QuestionSet): Promise<PolicyPrediction> {
    const raw = await this.bridge.predict({ state, questions, model: this.model });
    return {
      ...raw,
      routing: {
        ...raw.routing,
        backend: "laya",
      },
    };
  }
}
