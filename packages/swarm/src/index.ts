import {
  TEMPORARY_EARLY_TEST_AGENT_CAP,
  boardSession,
  runtimeForRole,
  type AgentRole,
  type StoodUpAgent,
  type SwarmSession,
} from "@opencodingpartner/mesh";

/**
 * Orchestration agent swarm. OpenClaw-shaped session plus stand-up, list, and dispatch.
 * This package does not vendor OpenClaw. The operator installs the gateway later.
 */
export class OrchestrationSwarm {
  readonly session: SwarmSession;
  private agents: StoodUpAgent[] = [];

  constructor(session: SwarmSession = boardSession()) {
    this.session = session;
  }

  standUp(roles: readonly AgentRole[]): StoodUpAgent[] {
    if (roles.length > TEMPORARY_EARLY_TEST_AGENT_CAP) {
      throw new Error(
        `Temporary early-test cap is ${TEMPORARY_EARLY_TEST_AGENT_CAP} agents. Multi-agent is the product. This cap is not a one-worker rule.`,
      );
    }
    const seen = new Map<AgentRole, number>();
    this.agents = roles.map((role) => {
      const next = (seen.get(role) ?? 0) + 1;
      seen.set(role, next);
      return {
        role,
        id: `${role}-${next}`,
        runtime: runtimeForRole(role),
      };
    });
    return this.list();
  }

  list(): StoodUpAgent[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  dispatch<T>(role: AgentRole, run: (agent: StoodUpAgent) => T): T {
    const agent = this.agents.find((item) => item.role === role);
    if (!agent) {
      throw new Error(`No ${role} agent is stood up on session ${this.session.key}.`);
    }
    return run(agent);
  }
}
