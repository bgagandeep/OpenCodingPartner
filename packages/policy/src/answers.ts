import type { ChoiceAnswer, ChoiceCriteria, NoulAnswer, ScoreAnswer } from "@opencodingpartner/mesh";

const TOP_MASS = 0.84;

export function choiceAnswer(choice: string, criteria: ChoiceCriteria): ChoiceAnswer {
  const labels = Object.keys(criteria);
  if (!labels.includes(choice)) {
    throw new Error(`choice ${choice} is not in the question criteria`);
  }
  const rest = labels.length === 1 ? 0 : (1 - TOP_MASS) / (labels.length - 1);
  const probabilities: Record<string, number> = {};
  for (const label of labels) {
    probabilities[label] = label === choice ? TOP_MASS : rest;
  }
  return {
    type: "choice",
    choice,
    probabilities,
    confidence: TOP_MASS,
    rl_agent: { act_probability: choice === "none" ? 0.2 : 1 },
  };
}

export function scoreAnswer(level: number, labels: readonly string[]): ScoreAnswer {
  if (level < 0 || level >= labels.length || !Number.isInteger(level)) {
    throw new Error(`score level ${level} is outside the rubric`);
  }
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  const rest = labels.length === 1 ? 0 : (1 - TOP_MASS) / (labels.length - 1);
  labels.forEach((label, index) => {
    legend[String(index)] = label;
    probabilities[String(index)] = index === level ? TOP_MASS : rest;
  });
  let score = 0;
  for (const [index, probability] of Object.entries(probabilities)) {
    score += Number(index) * probability;
  }
  return {
    type: "score",
    score,
    legend,
    probabilities,
    confidence: TOP_MASS,
    rl_agent: { act_probability: 1 },
  };
}

export function noulAnswer(probability: number): NoulAnswer {
  if (probability < 0 || probability > 1) {
    throw new Error("noul probability must be between 0 and 1");
  }
  return {
    type: "noul",
    noul: probability,
    rl_agent: { act_probability: 1 },
  };
}
