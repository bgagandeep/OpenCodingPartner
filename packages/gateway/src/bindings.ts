export interface AgentBinding {
  readonly channel: string;
  readonly accountId: string;
  readonly agentId: string;
  readonly sessionKey: string;
}

export const FOUNDATION_BINDINGS: readonly AgentBinding[] = [
  {
    channel: "cli",
    accountId: "local",
    agentId: "board",
    sessionKey: "agent:board:main",
  },
];

export function resolveBinding(channel: string, accountId: string): AgentBinding {
  const binding = FOUNDATION_BINDINGS.find(
    (candidate) => candidate.channel === channel && candidate.accountId === accountId,
  );
  if (binding === undefined) {
    throw new Error(`no binding for channel ${channel} account ${accountId}`);
  }
  return binding;
}
