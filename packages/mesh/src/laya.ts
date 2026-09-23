export type ChoiceCriteria = Readonly<Record<string, string>>;

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: ChoiceCriteria;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export type LayaQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type QuestionSet = Readonly<Record<string, LayaQuestion>>;

export interface RlAgentMeta {
  readonly act_probability: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly rl_agent: RlAgentMeta;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly rl_agent: RlAgentMeta;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
  readonly rl_agent: RlAgentMeta;
}

export interface MeshRouteAnswers {
  readonly disposition: ChoiceAnswer;
  readonly manager: ChoiceAnswer;
  readonly worker: ChoiceAnswer;
  readonly urgency: ScoreAnswer;
  readonly needs_human: NoulAnswer;
}

export type PolicyBackend = "mock-heuristic" | "laya";

export interface PolicyRouting {
  readonly model: string;
  readonly repo: string | null;
  readonly reason: string;
  readonly backend: PolicyBackend;
}

export interface PolicyUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface PolicyPrediction {
  readonly answers: MeshRouteAnswers;
  readonly routing: PolicyRouting;
  readonly usage: PolicyUsage;
}

export interface PolicyState {
  readonly channel: string;
  readonly accountId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly message: string;
}
