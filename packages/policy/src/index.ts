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

/** One session plan. OpenClaw owns it when the gateway accepts it. */
export interface ManagerPlan {
  sessionKey: string;
  source: "openclaw" | "local-manager";
  roles: AgentRole[];
  steps: string[];
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

const FALLBACK_NOTE = "System-1: fallback. Laya is not installed or the call failed.";
const REAL_NOTE = "System-1: real Laya.";

/** System-1 route only. This function does not write files or run tools. */
export function routeMessage(message: string): RouteDecision {
  return decisionFromAnswers(mockPredict(message, ROUTE_QUESTIONS), "System-1: fallback. Laya is not installed.");
}

export type LayaPredict = (state: string, questions: readonly LayaQuestion[]) => Promise<unknown>;

/**
 * Use a real Laya `Router.predict` result when the caller can produce one.
 * A thrown call or an unreadable choice falls back and says so.
 */
export async function routeWithPredict(message: string, predict: LayaPredict): Promise<RouteDecision> {
  try {
    const raw = await predict(message, ROUTE_QUESTIONS);
    const answers = parseLayaAnswers(raw);
    const choice = answers.find((answer) => answer.id === "route" && answer.type === "choice");
    if (choice?.type !== "choice" || (choice.choice !== "multi-agent" && choice.choice !== "status")) {
      return decisionFromAnswers(mockPredict(message, ROUTE_QUESTIONS), FALLBACK_NOTE);
    }
    return decisionFromAnswers(answers, REAL_NOTE);
  } catch {
    return decisionFromAnswers(mockPredict(message, ROUTE_QUESTIONS), FALLBACK_NOTE);
  }
}

export function questionsForRoute(): readonly LayaQuestion[] {
  return ROUTE_QUESTIONS;
}

function decisionFromAnswers(answers: LayaAnswer[], note: string): RouteDecision {
  const choice = answers.find((answer) => answer.id === "route" && answer.type === "choice");
  const route = choice?.type === "choice" && choice.choice === "multi-agent" ? "multi-agent" : "status";
  const roles: AgentRole[] = route === "multi-agent" ? ["coding", "qa", "security", "computer"] : [];
  return { route, roles, answers, note };
}

/** Accept Laya's `{ answers, routing }` object or a flat answer list. */
export function parseLayaAnswers(raw: unknown): LayaAnswer[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => parseOneAnswer(item));
  if (!raw || typeof raw !== "object") return [];
  const answers = (raw as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];
  return Object.entries(answers as Record<string, unknown>).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    return parseOneAnswer({ id, ...(value as Record<string, unknown>) });
  });
}

function parseOneAnswer(raw: unknown): LayaAnswer[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return [];
  if (typeof record.choice === "string") {
    const probabilities =
      record.probabilities && typeof record.probabilities === "object"
        ? (record.probabilities as Record<string, number>)
        : { [record.choice]: 1 };
    return [
      {
        id,
        type: "choice",
        choice: record.choice,
        probabilities,
        confidence: typeof record.confidence === "number" ? record.confidence : 0,
        rl_agent: typeof record.rl_agent === "string" ? record.rl_agent : "laya",
      },
    ];
  }
  if (typeof record.noul === "number") return [{ id, type: "noul", noul: record.noul }];
  if (typeof record.score === "number") {
    return [
      {
        id,
        type: "score",
        score: record.score,
        legend: typeof record.legend === "string" ? record.legend : "",
      },
    ];
  }
  return [];
}
