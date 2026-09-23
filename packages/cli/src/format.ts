import type { TurnResult } from "@opencodingpartner/mesh";

export function formatTurn(turn: TurnResult): string {
  const worker = turn.prediction.answers.worker.choice;
  const lines = [
    "OpenCodingPartner",
    `session        ${turn.sessionKey}`,
    `turn           ${turn.idempotencyKey}`,
    `disposition    ${turn.disposition}`,
    `manager        ${turn.prediction.answers.manager.choice}`,
    `worker         ${worker}`,
    `backend        ${turn.prediction.routing.backend}`,
    `dispatched     ${turn.dispatched ? "yes" : "no"}`,
    `replayed       ${turn.replayed ? "yes" : "no"}`,
    `ok             ${turn.ok ? "yes" : "no"}`,
    "",
    turn.reply,
    "",
  ];
  return lines.join("\n");
}
