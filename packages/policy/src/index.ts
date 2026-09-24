import type { AgentRole } from "@opencodingpartner/mesh";

/** Question types Laya scores in one pass: choice, score, and noul. */
export type LayaQuestion =
  | { id: string; type: "choice"; text: string; options: string[] }
  | { id: string; type: "score"; text: string }
  | { id: string; type: "noul"; text: string };

export interface LayaChoiceAnswer {
  id: string;
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  rl_agent: string;
}

export interface LayaScoreAnswer {
  id: string;
  type: "score";
  score: number;
  legend: string;
}

export interface LayaNoulAnswer {
  id: string;
  type: "noul";
  /** P(true), matching Laya's noul output. */
  noul: number;
}

export type LayaAnswer = LayaChoiceAnswer | LayaScoreAnswer | LayaNoulAnswer;

export interface RouteDecision {
  route: "multi-agent" | "status";
  roles: AgentRole[];
  answers: LayaAnswer[];
  note: string;
}

const ROUTE_QUESTIONS: LayaQuestion[] = [
  {
    id: "route",
    type: "choice",
    text: "Which route should this chat turn take?",
    options: ["multi-agent", "status"],
  },
  {
    id: "stand_up_computer",
    type: "noul",
    text: "Should this turn stand up a computer agent for go-to-market help?",
  },
  {
    id: "write_risk",
    type: "score",
    text: "How careful should the security agent be before a file write?",
  },
];

/**
 * Offline stand-in for `Router.predict`. It does not load weights and it does
 * not call a hosted Laya service. The real bridge is integrations/laya/predict.py.
 */
export function mockPredict(state: string, questions: readonly LayaQuestion[]): LayaAnswer[] {
  const buildAndSell = wantsAgents(state);
  return questions.map((question) => {
    if (question.type === "choice") {
      const choice = buildAndSell ? "multi-agent" : "status";
      return {
        id: question.id,
        type: "choice",
        choice,
        probabilities: { "multi-agent": buildAndSell ? 0.92 : 0.08, status: buildAndSell ? 0.08 : 0.92 },
        confidence: 0.9,
        rl_agent: "mock-offline",
      };
    }
    if (question.type === "noul") {
      return { id: question.id, type: "noul", noul: buildAndSell ? 0.88 : 0.1 };
    }
    return {
      id: question.id,
      type: "score",
      score: 0.8,
      legend: "Check path escape and secrets before any write.",
    };
  });
}

export function wantsAgents(state: string): boolean {
  const text = state.trim();
  if (/^(hello|hi|hey|status|help)\.?$/i.test(text)) return false;
  return /stand up|coding agent|qa agent|security agent|computer agent|\bcreate\b|\bsell\b|\badd\b|\bedit\b|\bfix\b|\bwrite\b|\brefactor\b|\breadme\b/i.test(
    text,
  );
}

/** System-1 route only. This function does not write files or run tools. */
export function routeMessage(message: string): RouteDecision {
  const answers = mockPredict(message, ROUTE_QUESTIONS);
  const choice = answers.find((answer) => answer.type === "choice");
  const route = choice?.type === "choice" && choice.choice === "multi-agent" ? "multi-agent" : "status";
  const roles: AgentRole[] =
    route === "multi-agent" ? ["coding", "qa", "security", "computer"] : [];
  return {
    route,
    roles,
    answers,
    note: "Laya-class System-1 mock. Route and policy only.",
  };
}
