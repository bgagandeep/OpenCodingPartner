export const FOUNDATION_LIMITS = {
  ads: false,
  payments: false,
  speculativeSwarm: false,
  maxWorkersPerTurn: 1,
} as const;

export type FoundationLimits = typeof FOUNDATION_LIMITS;

export const NEEDS_HUMAN_BLOCK_AT = 0.5;
