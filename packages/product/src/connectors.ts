import { callHttpMcpTool, connectorAuthHeaders, HttpMcpError, listHttpMcpTools, type HttpMcpEndpoint, type HttpMcpTool } from "./http-mcp.js";

export type ConnectorStatus = "unknown" | "up" | "down" | "auth-rejected" | "error";

export interface ConnectorSnapshot {
  name: string;
  url: string;
  authHeader?: string;
  status?: ConnectorStatus;
  lastError?: string;
  lastCheckedAt?: string;
  toolNames?: string[];
}

export interface PublicConnector {
  name: string;
  url: string;
  authHeader?: string;
  authConfigured: boolean;
  status: ConnectorStatus;
  lastError?: string;
  lastCheckedAt?: string;
  toolNames: string[];
}

const SERVER_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,80}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;

export function externalToolName(server: string, tool: string): string {
  return `mcp:${server}/${tool}`;
}

export function parseExternalToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp:([A-Za-z0-9._-]{1,80})\/([A-Za-z0-9._:-]{1,80})$/.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  return { server: match[1], tool: match[2] };
}

/** External MCP calls always need the approval gate. Built-in discovery targets do not. */
export function externalToolNeedsApproval(toolName: string, args: Record<string, unknown>): boolean {
  if (parseExternalToolName(toolName)) return true;
  if (toolName === "tool_call" && typeof args.name === "string" && parseExternalToolName(args.name)) return true;
  return false;
}

export function publicConnector(server: ConnectorSnapshot, authConfigured: boolean): PublicConnector {
  return {
    name: server.name,
    url: server.url,
    authHeader: server.authHeader,
    authConfigured,
    status: server.status ?? "unknown",
    lastError: server.lastError,
    lastCheckedAt: server.lastCheckedAt,
    toolNames: server.toolNames ?? [],
  };
}

export function validateConnectorInput(input: { name: string; url: string; authHeader?: string }): { ok: true; name: string; url: string; authHeader?: string } | { ok: false; error: string } {
  const name = input.name.trim();
  const urlText = input.url.trim();
  const authHeader = input.authHeader?.trim() || undefined;
  if (!SERVER_NAME.test(name)) return { ok: false, error: "Connector name must be 1-80 letters, numbers, dots, underscores, or dashes." };
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return { ok: false, error: "Connector URL must be http or https." };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return { ok: false, error: "Connector URL must be http or https without credentials in the URL." };
  }
  if (authHeader && !HEADER_NAME.test(authHeader)) return { ok: false, error: "Auth header name is invalid." };
  return { ok: true, name, url: url.toString(), authHeader };
}

export function upsertConnectorSnapshot(current: readonly ConnectorSnapshot[], next: ConnectorSnapshot): ConnectorSnapshot[] {
  const rest = current.filter((server) => server.name !== next.name);
  return [...rest, next];
}

export async function probeConnectors(
  servers: readonly ConnectorSnapshot[],
  tokens: ReadonlyMap<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ servers: ConnectorSnapshot[]; errors: string[]; endpoints: HttpMcpEndpoint[] }> {
  const checkedAt = new Date().toISOString();
  const next: ConnectorSnapshot[] = [];
  const errors: string[] = [];
  const endpoints: HttpMcpEndpoint[] = [];
  for (const server of servers) {
    const token = tokens.get(server.name);
    const endpoint: HttpMcpEndpoint = {
      name: server.name,
      url: server.url,
      headers: connectorAuthHeaders(server.authHeader, token),
    };
    try {
      const tools = await listHttpMcpTools(endpoint, fetchImpl);
      const loaded: string[] = [];
      const rejected: string[] = [];
      for (const tool of tools) {
        if (TOOL_NAME.test(tool.name)) loaded.push(externalToolName(server.name, tool.name));
        else rejected.push(tool.name.slice(0, 80));
      }
      const rejection = rejected.length
        ? `MCP server "${server.name}" skipped tool names that are not simple tokens: ${rejected.join(", ")}.`
        : undefined;
      if (rejection && loaded.length === 0) errors.push(rejection);
      next.push({
        ...server,
        status: rejection && loaded.length === 0 ? "error" : "up",
        lastError: rejection,
        lastCheckedAt: checkedAt,
        toolNames: loaded,
      });
      if (loaded.length > 0 || !rejection) endpoints.push(endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : `MCP server "${server.name}" failed.`;
      const status: ConnectorStatus = error instanceof HttpMcpError && error.kind === "auth"
        ? "auth-rejected"
        : error instanceof HttpMcpError && error.kind === "down"
          ? "down"
          : "error";
      errors.push(message);
      next.push({ ...server, status, lastError: message, lastCheckedAt: checkedAt, toolNames: [] });
    }
  }
  return { servers: next, errors, endpoints };
}

export interface ExternalToolCatalog {
  tools: Array<HttpMcpTool & { server: string; qualifiedName: string }>;
  errors: string[];
  endpoints: HttpMcpEndpoint[];
}

export function readExternalMcpEnv(env: NodeJS.ProcessEnv = process.env): HttpMcpEndpoint[] {
  const raw = env.OCP_EXTERNAL_MCP;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpMcpError("External MCP configuration is unreadable.", "protocol");
  }
  if (!Array.isArray(parsed)) throw new HttpMcpError("External MCP configuration is unreadable.", "protocol");
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { name?: unknown; url?: unknown; headers?: unknown };
    if (typeof record.name !== "string" || typeof record.url !== "string") return [];
    const headers: Record<string, string> = {};
    if (record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)) {
      for (const [key, value] of Object.entries(record.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    return [{ name: record.name, url: record.url, headers }];
  });
}

export async function loadExternalCatalog(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<ExternalToolCatalog> {
  let endpoints: HttpMcpEndpoint[];
  try {
    endpoints = readExternalMcpEnv(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "External MCP configuration is unreadable.";
    return { tools: [], errors: [message], endpoints: [] };
  }
  const tools: ExternalToolCatalog["tools"] = [];
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const listed = await listHttpMcpTools(endpoint, fetchImpl);
      for (const tool of listed) {
        if (!TOOL_NAME.test(tool.name)) {
          errors.push(`MCP server "${endpoint.name}" skipped tool "${tool.name.slice(0, 80)}" because the name is not a simple token.`);
          continue;
        }
        tools.push({ ...tool, server: endpoint.name, qualifiedName: externalToolName(endpoint.name, tool.name) });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `MCP server "${endpoint.name}" failed.`);
    }
  }
  return { tools, errors, endpoints };
}

export async function invokeExternalTool(
  qualifiedName: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  const parsed = parseExternalToolName(qualifiedName);
  if (!parsed) return { ok: false, detail: `Unknown external MCP tool ${qualifiedName}.` };
  let endpoints: HttpMcpEndpoint[];
  try {
    endpoints = readExternalMcpEnv(env);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "External MCP configuration is unreadable." };
  }
  const endpoint = endpoints.find((item) => item.name === parsed.server);
  if (!endpoint) return { ok: false, detail: `MCP server "${parsed.server}" is not attached to this session.` };
  try {
    const detail = await callHttpMcpTool(endpoint, parsed.tool, args, fetchImpl);
    return { ok: true, detail: detail.slice(0, 16_000) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : `MCP server "${parsed.server}" failed.` };
  }
}
