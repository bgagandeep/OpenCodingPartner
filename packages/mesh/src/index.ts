/** Agent roles the chat agent can stand up. Multi-agent is the product. */
export const AGENT_ROLES = ["coding", "qa", "security", "computer"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/** OpenClaw-shaped binding: channel, account, and agent. */
export interface SessionBinding {
  channel: string;
  accountId: string;
  agentId: string;
}

export interface SwarmSession {
  /** OpenClaw session key, for example `agent:board:main`. */
  key: string;
  binding: SessionBinding;
}

export const BOARD_BINDING: SessionBinding = {
  channel: "cli",
  accountId: "local",
  agentId: "board",
};

export const BOARD_SESSION_KEY = "agent:board:main";

export function boardSession(): SwarmSession {
  return { key: BOARD_SESSION_KEY, binding: { ...BOARD_BINDING } };
}

export interface StoodUpAgent {
  role: AgentRole;
  id: string;
  /** Which tool this role runs on. */
  runtime: "grok-build" | "computer-use" | "policy-security";
}

/**
 * Temporary eng safety default for early offline tests.
 * This is not a product rule. The product stands up multiple agents.
 */
export const TEMPORARY_EARLY_TEST_AGENT_CAP = 8;

export const PRODUCT_FLAGS = {
  ads: false,
  payments: false,
} as const;

export function runtimeForRole(role: AgentRole): StoodUpAgent["runtime"] {
  if (role === "coding" || role === "qa") return "grok-build";
  if (role === "computer") return "computer-use";
  return "policy-security";
}
