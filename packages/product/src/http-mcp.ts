/** Streamable HTTP JSON-RPC client for remote MCP servers. Failures are errors, never empty success. */

export interface HttpMcpEndpoint {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface HttpMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type HttpMcpFailure = "down" | "auth" | "protocol";

export class HttpMcpError extends Error {
  readonly kind: HttpMcpFailure;

  constructor(message: string, kind: HttpMcpFailure) {
    super(message);
    this.name = "HttpMcpError";
    this.kind = kind;
  }
}

export function connectorAuthHeaders(headerName: string | undefined, token: string | undefined): Record<string, string> {
  const secret = token?.trim() ?? "";
  if (!secret) return {};
  const name = (headerName?.trim() || "Authorization") || "Authorization";
  const value = name.toLowerCase() === "authorization" && !/^(bearer|basic)\s+/i.test(secret) ? `Bearer ${secret}` : secret;
  return { [name]: value };
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 400);
}

function endpointSecrets(endpoint: HttpMcpEndpoint): string[] {
  const values = Object.values(endpoint.headers ?? {});
  const bare = values.flatMap((value) => {
    const token = value.replace(/^(bearer|basic)\s+/i, "").trim();
    return token && token !== value.trim() ? [token] : [];
  });
  return [...values, ...bare].map((value) => value.trim()).filter((value) => value.length >= 4);
}

export async function listHttpMcpTools(endpoint: HttpMcpEndpoint, fetchImpl: typeof fetch = fetch): Promise<HttpMcpTool[]> {
  const session = await openHttpMcp(endpoint, fetchImpl);
  const listed = await session.request("tools/list", {}) as { tools?: unknown };
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const record = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof record.name !== "string" || !record.name.trim()) return [];
    const schema = record.inputSchema && typeof record.inputSchema === "object" && !Array.isArray(record.inputSchema)
      ? record.inputSchema as Record<string, unknown>
      : { type: "object", properties: {} };
    return [{
      name: record.name.trim(),
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: schema,
    }];
  });
}

export async function callHttpMcpTool(
  endpoint: HttpMcpEndpoint,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const session = await openHttpMcp(endpoint, fetchImpl);
  const result = await session.request("tools/call", { name: toolName, arguments: args }) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = Array.isArray(result?.content) ? result.content.map((part) => part.text ?? "").join("\n") : JSON.stringify(result ?? {});
  if (result?.isError) {
    throw new HttpMcpError(`MCP server "${endpoint.name}" tool "${toolName}" failed: ${redact(text || "tool error", endpointSecrets(endpoint))}`, "protocol");
  }
  return text;
}

async function openHttpMcp(endpoint: HttpMcpEndpoint, fetchImpl: typeof fetch): Promise<{ request: (method: string, params: Record<string, unknown>) => Promise<unknown> }> {
  let sessionId: string | undefined;
  let nextId = 1;
  const init = await postRpc(endpoint, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "opencodingpartner", version: "0.1.0" },
  }, nextId++, sessionId, fetchImpl);
  sessionId = init.sessionId ?? sessionId;
  await postNotification(endpoint, "notifications/initialized", sessionId, fetchImpl);
  return {
    request: async (method, params) => {
      const response = await postRpc(endpoint, method, params, nextId++, sessionId, fetchImpl);
      sessionId = response.sessionId ?? sessionId;
      return response.result;
    },
  };
}

async function postNotification(endpoint: HttpMcpEndpoint, method: string, sessionId: string | undefined, fetchImpl: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: rpcHeaders(endpoint, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw downError(endpoint, error);
  }
  if (response.status === 401 || response.status === 403) throw await authError(endpoint, response);
  if (response.status === 202 || response.status === 204 || response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return;
  }
  if (!response.ok) {
    const body = redact(await response.text().catch(() => ""), endpointSecrets(endpoint));
    throw new HttpMcpError(`MCP server "${endpoint.name}" returned HTTP ${response.status}${body ? `: ${body}` : "."}`, "protocol");
  }
}

async function postRpc(
  endpoint: HttpMcpEndpoint,
  method: string,
  params: Record<string, unknown>,
  id: number,
  sessionId: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ result: unknown; sessionId?: string }> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: rpcHeaders(endpoint, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw downError(endpoint, error);
  }
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  if (response.status === 401 || response.status === 403) throw await authError(endpoint, response);
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    const body = redact(raw, endpointSecrets(endpoint));
    throw new HttpMcpError(`MCP server "${endpoint.name}" returned HTTP ${response.status}${body ? `: ${body}` : "."}`, response.status >= 500 ? "down" : "protocol");
  }
  const message = parseRpcPayload(endpoint, response.headers.get("content-type") ?? "", raw, id);
  if (message.error) {
    const detail = redact(message.error, endpointSecrets(endpoint));
    throw new HttpMcpError(`MCP server "${endpoint.name}" rejected ${method}: ${detail}`, "protocol");
  }
  return { result: message.result, sessionId: nextSession || undefined };
}

function rpcHeaders(endpoint: HttpMcpEndpoint, sessionId: string | undefined): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...endpoint.headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

function parseRpcPayload(endpoint: HttpMcpEndpoint, contentType: string, raw: string, id: number): { result?: unknown; error?: string } {
  const secrets = endpointSecrets(endpoint);
  const candidates = contentType.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean)
    : [raw];
  for (const candidate of candidates) {
    let parsed: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(candidate) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.id !== undefined && parsed.id !== id) continue;
    if (parsed.error) return { error: parsed.error.message || "MCP error" };
    return { result: parsed.result };
  }
  throw new HttpMcpError(`MCP server "${endpoint.name}" returned an unreadable response: ${redact(raw, secrets) || "empty body"}`, "protocol");
}

function downError(endpoint: HttpMcpEndpoint, error: unknown): HttpMcpError {
  const reason = error instanceof Error ? error.message : "connection failed";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const detail = timedOut ? "timed out" : cause && !reason.includes(cause) ? `${reason}: ${cause}` : reason;
  return new HttpMcpError(
    `MCP server "${endpoint.name}" is down: ${redact(detail, endpointSecrets(endpoint))}`,
    "down",
  );
}

async function authError(endpoint: HttpMcpEndpoint, response: Response): Promise<HttpMcpError> {
  const body = redact(await response.text().catch(() => ""), endpointSecrets(endpoint));
  return new HttpMcpError(
    `MCP server "${endpoint.name}" rejected authentication (HTTP ${response.status})${body ? `: ${body}` : "."}`,
    "auth",
  );
}
