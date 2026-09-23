import type { ChoiceQuestion, NoulQuestion, QuestionSet, ScoreQuestion } from "@opencodingpartner/mesh";

const disposition: ChoiceQuestion = {
  type: "choice",
  instructions: "What should the mesh do with this operator turn?",
  criteria: {
    dispatch: "the operator named one concrete file and the bytes to write",
    answer: "the operator asked for mesh status and no file change",
    clarify: "the request does not name a file and its contents",
    decline: "the request asks the mesh to move money or run advertisements",
  },
};

const manager: ChoiceQuestion = {
  type: "choice",
  instructions: "Which manager owns the plan?",
  criteria: {
    "coding-manager": "plan one file write and nothing else",
    "conversation-manager": "report mesh status without a worker",
    none: "do not open a manager",
  },
};

const worker: ChoiceQuestion = {
  type: "choice",
  instructions: "Which coding runtime should execute a dispatched plan?",
  criteria: {
    "local-sandbox": "edit a folder on this machine",
    "cursor-cloud": "Cursor Cloud Agents v1, using the operator's own API key",
    "grok-build": "Grok Build headless mode, using the operator's own install",
    none: "no coding runtime on this turn",
  },
};

const urgency: ScoreQuestion = {
  type: "score",
  instructions: "How urgent is this turn?",
  criteria: ["low", "normal", "high"],
};

const needsHuman: NoulQuestion = {
  type: "noul",
  instructions: "A human should stop this turn before a worker runs.",
};

export const MESH_ROUTE_QUESTIONS: QuestionSet = {
  disposition,
  manager,
  worker,
  urgency,
  needs_human: needsHuman,
};
