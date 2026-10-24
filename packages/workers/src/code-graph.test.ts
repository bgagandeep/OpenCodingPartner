import assert from "node:assert/strict";
import test from "node:test";
import { CodePropertyGraph, extractTypeScriptSymbols } from "./code-graph.js";

const SAMPLE_AUTH_CODE = `
export interface UserSession {
  userId: string;
  role: string;
}

export type TokenString = string;

/** Verifies the authentication bearer token. */
export function verifyToken(token: TokenString): boolean {
  return token.length > 10;
}

export class AuthManager {
  check(session: UserSession): boolean {
    return session.role === "admin";
  }
}

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true });
});
`;

const SAMPLE_SERVICE_CODE = `
import { verifyToken, UserSession } from "./auth.js";

export function handleRequest(token: string): boolean {
  if (!verifyToken(token)) {
    return false;
  }
  return true;
}

export function routeHandler(token: string): boolean {
  return handleRequest(token);
}
`;

test("AST symbol extraction for functions, classes, interfaces, types, and routes", () => {
  const symbols = extractTypeScriptSymbols("src/auth.ts", SAMPLE_AUTH_CODE);
  assert.equal(symbols.length, 5);

  const iface = symbols.find((s) => s.name === "UserSession");
  assert.ok(iface);
  assert.equal(iface.kind, "interface");
  assert.equal(iface.isExported, true);

  const typeNode = symbols.find((s) => s.name === "TokenString");
  assert.ok(typeNode);
  assert.equal(typeNode.kind, "type");

  const func = symbols.find((s) => s.name === "verifyToken");
  assert.ok(func);
  assert.equal(func.kind, "function");
  assert.equal(func.docstring, "Verifies the authentication bearer token.");

  const cls = symbols.find((s) => s.name === "AuthManager");
  assert.ok(cls);
  assert.equal(cls.kind, "class");

  const route = symbols.find((s) => s.name === "GET /api/auth/me");
  assert.ok(route);
  assert.equal(route.kind, "route");
});

test("CodePropertyGraph indexing, callers, callees, and blast radius calculation", () => {
  const graph = new CodePropertyGraph();
  graph.indexFile("src/auth.ts", SAMPLE_AUTH_CODE);
  graph.indexFile("src/service.ts", SAMPLE_SERVICE_CODE);

  assert.equal(graph.getNodeCount(), 7); // 5 from auth + 2 from service
  assert.ok(graph.getEdgeCount() >= 2);

  // Callers
  const callers = graph.getCallers("verifyToken");
  assert.ok(callers.some((c) => c.name === "handleRequest"));

  // Callees
  const callees = graph.getCallees("handleRequest");
  assert.ok(callees.some((c) => c.name === "verifyToken"));

  // Blast radius of verifyToken (should cascade to handleRequest and routeHandler)
  const blast = graph.calculateBlastRadius("src/auth.ts", "verifyToken", 3);
  assert.equal(blast.targetSymbol, "verifyToken");
  assert.ok(blast.affectedSymbols.some((s) => s.name === "handleRequest"));
  assert.ok(blast.affectedSymbols.some((s) => s.name === "routeHandler"));
  assert.ok(blast.affectedFiles.includes("src/service.ts"));
  assert.equal(blast.riskLevel, "medium");

  // RepoMap generation
  const repomap = graph.generateRepoMap(1000);
  assert.match(repomap, /# Codebase Symbol Outline/);
  assert.match(repomap, /verifyToken/);
});
