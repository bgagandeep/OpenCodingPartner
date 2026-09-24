export interface DemoArgs {
  readonly command: "demo";
  readonly sandbox: string;
  readonly message?: string;
  readonly json: boolean;
  readonly idempotencyKey?: string;
}

export interface RunArgs {
  readonly command: "run";
  readonly sandbox: string;
  readonly message: string;
  readonly json: boolean;
  readonly idempotencyKey?: string;
}

export interface RouteArgs {
  readonly command: "route";
  readonly message: string;
  readonly json: boolean;
}

export type CliArgs = DemoArgs | RunArgs | RouteArgs | { readonly command: "help" };

export function parseCli(argv: readonly string[]): CliArgs | { readonly command: "error"; readonly message: string } {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "demo" && command !== "run" && command !== "route") {
    return { command: "error", message: `unknown command ${command}` };
  }

  const flags = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (!token.startsWith("--")) {
      return { command: "error", message: `unexpected argument ${token}` };
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { command: "error", message: `missing value for --${key}` };
    }
    flags.set(key, value);
    index += 1;
  }

  const message = flags.get("message");
  const idempotencyKey = flags.get("idempotency-key");
  if (command === "route") {
    if (message === undefined) {
      return { command: "error", message: "route requires --message" };
    }
    return { command, message, json };
  }

  const sandbox = flags.get("sandbox") ?? (command === "demo" ? ".sandbox" : undefined);
  if (sandbox === undefined) {
    return { command: "error", message: "run requires --sandbox" };
  }
  if (command === "run" && message === undefined) {
    return { command: "error", message: "run requires --message" };
  }
  if (command === "demo") {
    return { command, sandbox, json, ...(message === undefined ? {} : { message }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
  }
  return {
    command,
    sandbox,
    message: message ?? "",
    json,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

export const HELP = `OpenCodingPartner mesh CLI

ocp demo [--sandbox DIR] [--message TEXT] [--json]
ocp run --sandbox DIR --message TEXT [--idempotency-key KEY] [--json]
ocp route --message TEXT [--json]

demo runs two turns: a status reply, then a sandbox write of BOARD.md.
Pass --message to demo to run that single turn instead.
The grammar for a file turn is:

  create RELATIVE_PATH with content:
  file bytes
`;
