import type {
  ChoiceQuestion,
  PolicyPrediction,
  PolicyState,
  QuestionSet,
  ScoreQuestion,
} from "@opencodingpartner/mesh";

import { choiceAnswer, noulAnswer, scoreAnswer } from "./answers.js";
import { classifyMessage } from "./classify.js";
import type { PolicyRouter } from "./router.js";

function asChoice(questions: QuestionSet, id: string): ChoiceQuestion {
  const question = questions[id];
  if (question === undefined || question.type !== "choice") {
    throw new Error(`route question ${id} must be a choice`);
  }
  return question;
}

function asScore(questions: QuestionSet, id: string): ScoreQuestion {
  const question = questions[id];
  if (question === undefined || question.type !== "score") {
    throw new Error(`route question ${id} must be a score`);
  }
  return question;
}

export class MockLayaPolicyRouter implements PolicyRouter {
  async predict(state: PolicyState, questions: QuestionSet): Promise<PolicyPrediction> {
    const classified = classifyMessage(state.message);
    const reason = [
      classified.reason,
      "Weights were not loaded.",
      "Numbers in this payload match the Laya answer schema and are heuristic placeholders, not a forward pass.",
      "Real call: python integrations/laya/predict.py after the operator installs the laya package.",
      "Default checkpoint: convaiinnovations/laya (ModernBERT-large, about 421M).",
    ].join(" ");

    return {
      answers: {
        disposition: choiceAnswer(classified.disposition, asChoice(questions, "disposition").criteria),
        manager: choiceAnswer(classified.manager, asChoice(questions, "manager").criteria),
        worker: choiceAnswer(classified.worker, asChoice(questions, "worker").criteria),
        urgency: scoreAnswer(classified.urgencyLevel, asScore(questions, "urgency").criteria),
        needs_human: noulAnswer(classified.needsHuman),
      },
      routing: {
        backend: "mock-heuristic",
        model: "mock",
        repo: null,
        reason,
      },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}
