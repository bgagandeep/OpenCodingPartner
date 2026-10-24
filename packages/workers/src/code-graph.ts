export type SymbolKind = "function" | "class" | "interface" | "method" | "type" | "route" | "variable";
export type EdgeKind = "calls" | "imports" | "inherits" | "implements" | "references";

export interface CodeSymbolNode {
  id: string; // e.g. "src/auth.ts:verifyToken"
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
  docstring?: string;
  calls?: string[]; // Names of symbols this node calls
}

export interface CodeSymbolEdge {
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
}

export interface BlastRadiusResult {
  targetSymbol: string;
  targetFile: string;
  affectedSymbols: Array<{
    id: string;
    name: string;
    file: string;
    line: number;
    depth: number;
    relation: EdgeKind;
  }>;
  affectedFiles: string[];
  riskLevel: "low" | "medium" | "high";
  directCallersCount: number;
}

export interface RepoMapEntry {
  filePath: string;
  symbols: Array<{
    name: string;
    kind: SymbolKind;
    line: number;
    signature: string;
    rank: number;
  }>;
}

/**
 * Extracts symbols and call dependencies from TypeScript / JavaScript source code.
 */
export function extractTypeScriptSymbols(filePath: string, content: string): CodeSymbolNode[] {
  const lines = content.split("\n");
  const symbols: CodeSymbolNode[] = [];

  // Patterns for function, class, interface, type, route
  const funcRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/;
  const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([a-zA-Z0-9_$]+))?(?:\s+implements\s+([^{]+))?/;
  const interfaceRegex = /^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+([^{]+))?/;
  const typeRegex = /^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)(?:\s*<[^>]+>)?\s*=/;
  const constFuncRegex = /^(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)(?:\s*:\s*([^=>]+))?\s*=>/;
  const routeRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/;

  let pendingDoc: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("/**") || trimmed.startsWith("*")) {
      pendingDoc.push(trimmed.replace(/^\/\*\*|\*\/|\*/g, "").trim());
      continue;
    }

    const docstring = pendingDoc.length > 0 ? pendingDoc.filter(Boolean).join(" ") : undefined;
    pendingDoc = [];

    // Check function
    let match = funcRegex.exec(trimmed);
    if (match) {
      const name = match[1] ?? "";
      const isExported = trimmed.startsWith("export");
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "function",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed.replace(/\{$/, "").trim(),
        isExported,
        docstring,
      });
      continue;
    }

    // Check arrow function
    match = constFuncRegex.exec(trimmed);
    if (match) {
      const name = match[1] ?? "";
      const isExported = trimmed.startsWith("export");
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "function",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed.replace(/\{$/, "").trim(),
        isExported,
        docstring,
      });
      continue;
    }

    // Check class
    match = classRegex.exec(trimmed);
    if (match) {
      const name = match[1] ?? "";
      const isExported = trimmed.startsWith("export");
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "class",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed.replace(/\{$/, "").trim(),
        isExported,
        docstring,
      });
      continue;
    }

    // Check interface
    match = interfaceRegex.exec(trimmed);
    if (match) {
      const name = match[1] ?? "";
      const isExported = trimmed.startsWith("export");
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "interface",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed.replace(/\{$/, "").trim(),
        isExported,
        docstring,
      });
      continue;
    }

    // Check type
    match = typeRegex.exec(trimmed);
    if (match) {
      const name = match[1] ?? "";
      const isExported = trimmed.startsWith("export");
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "type",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: trimmed,
        isExported,
        docstring,
      });
      continue;
    }

    // Check HTTP route
    match = routeRegex.exec(trimmed);
    if (match) {
      const method = (match[1] ?? "get").toUpperCase();
      const routePath = match[2] ?? "/";
      const name = `${method} ${routePath}`;
      symbols.push({
        id: `${filePath}:${name}`,
        name,
        kind: "route",
        filePath,
        startLine: i + 1,
        endLine: i + 1,
        signature: `${method} ${routePath}`,
        isExported: true,
        docstring,
      });
      continue;
    }
  }

  // Second pass: extract call invocations for each function body
  const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "require", "import", "return", "function", "async", "await", "typeof", "delete"]);
  const callPattern = /\b([a-zA-Z0-9_$]+)\s*\(/g;

  for (let sIdx = 0; sIdx < symbols.length; sIdx++) {
    const sym = symbols[sIdx];
    if (!sym) continue;
    const nextSym = symbols[sIdx + 1];
    const bodyStart = sym.startLine - 1;
    const bodyEnd = nextSym ? nextSym.startLine - 1 : lines.length;
    sym.endLine = bodyEnd;

    const invocations: string[] = [];
    for (let l = bodyStart; l < bodyEnd; l++) {
      const line = lines[l] ?? "";
      let m: RegExpExecArray | null;
      while ((m = callPattern.exec(line)) !== null) {
        const identifier = m[1] ?? "";
        if (!KEYWORDS.has(identifier) && identifier !== sym.name && !invocations.includes(identifier)) {
          invocations.push(identifier);
        }
      }
    }
    sym.calls = invocations;
  }

  return symbols;
}

/**
 * In-memory Code Property Graph capturing nodes, call edges, and reference relations.
 */
export class CodePropertyGraph {
  private nodes = new Map<string, CodeSymbolNode>();
  private edges: CodeSymbolEdge[] = [];
  private fileIndex = new Map<string, string[]>(); // filePath -> symbol IDs

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.fileIndex.clear();
  }

  indexFile(filePath: string, content: string): CodeSymbolNode[] {
    const normalized = filePath.replace(/\\/g, "/");
    // Remove previous symbols for this file
    const existing = this.fileIndex.get(normalized) ?? [];
    for (const id of existing) {
      this.nodes.delete(id);
    }
    this.edges = this.edges.filter((e) => !e.sourceId.startsWith(`${normalized}:`) && !e.targetId.startsWith(`${normalized}:`));

    // Extract new symbols
    const symbols = extractTypeScriptSymbols(normalized, content);
    const ids: string[] = [];

    for (const sym of symbols) {
      this.nodes.set(sym.id, sym);
      ids.push(sym.id);
    }
    this.fileIndex.set(normalized, ids);

    // Rebuild edges
    this.rebuildEdges();
    return symbols;
  }

  private rebuildEdges(): void {
    const allSymbolsByName = new Map<string, CodeSymbolNode[]>();
    for (const sym of this.nodes.values()) {
      const list = allSymbolsByName.get(sym.name) ?? [];
      list.push(sym);
      allSymbolsByName.set(sym.name, list);
    }

    const newEdges: CodeSymbolEdge[] = [];
    for (const source of this.nodes.values()) {
      if (!source.calls) continue;
      for (const calledName of source.calls) {
        const targets = allSymbolsByName.get(calledName) ?? [];
        for (const target of targets) {
          if (target.id !== source.id) {
            newEdges.push({
              sourceId: source.id,
              targetId: target.id,
              kind: "calls",
            });
          }
        }
      }
    }
    this.edges = newEdges;
  }

  findSymbols(query: string, limit = 20): CodeSymbolNode[] {
    const q = query.toLowerCase();
    const results: CodeSymbolNode[] = [];
    for (const sym of this.nodes.values()) {
      if (sym.name.toLowerCase().includes(q) || sym.signature.toLowerCase().includes(q)) {
        results.push(sym);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  getCallers(symbolName: string): CodeSymbolNode[] {
    const callers: CodeSymbolNode[] = [];
    for (const edge of this.edges) {
      if (edge.kind === "calls") {
        const target = this.nodes.get(edge.targetId);
        if (target && target.name === symbolName) {
          const source = this.nodes.get(edge.sourceId);
          if (source && !callers.some((c) => c.id === source.id)) {
            callers.push(source);
          }
        }
      }
    }
    return callers;
  }

  getCallees(symbolName: string): CodeSymbolNode[] {
    const callees: CodeSymbolNode[] = [];
    for (const edge of this.edges) {
      if (edge.kind === "calls") {
        const source = this.nodes.get(edge.sourceId);
        if (source && source.name === symbolName) {
          const target = this.nodes.get(edge.targetId);
          if (target && !callees.some((c) => c.id === target.id)) {
            callees.push(target);
          }
        }
      }
    }
    return callees;
  }

  calculateBlastRadius(targetFile: string, symbolName: string, maxDepth = 3): BlastRadiusResult {
    const normalizedFile = targetFile.replace(/\\/g, "/");
    const targetId = `${normalizedFile}:${symbolName}`;
    const targetNode = this.nodes.get(targetId) ?? [...this.nodes.values()].find((n) => n.name === symbolName);

    if (!targetNode) {
      return {
        targetSymbol: symbolName,
        targetFile,
        affectedSymbols: [],
        affectedFiles: [],
        riskLevel: "low",
        directCallersCount: 0,
      };
    }

    const visited = new Set<string>([targetNode.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: targetNode.id, depth: 0 }];
    const affected: BlastRadiusResult["affectedSymbols"] = [];
    const affectedFilesSet = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;

      // Find all symbols that call or reference this current symbol
      for (const edge of this.edges) {
        if (edge.targetId === current.id && !visited.has(edge.sourceId)) {
          visited.add(edge.sourceId);
          const callerNode = this.nodes.get(edge.sourceId);
          if (callerNode) {
            affected.push({
              id: callerNode.id,
              name: callerNode.name,
              file: callerNode.filePath,
              line: callerNode.startLine,
              depth: current.depth + 1,
              relation: edge.kind,
            });
            affectedFilesSet.add(callerNode.filePath);
            queue.push({ id: callerNode.id, depth: current.depth + 1 });
          }
        }
      }
    }

    const directCallersCount = affected.filter((a) => a.depth === 1).length;
    let riskLevel: BlastRadiusResult["riskLevel"] = "low";
    if (directCallersCount >= 4 || affected.length >= 8 || affectedFilesSet.size >= 3) {
      riskLevel = "high";
    } else if (directCallersCount >= 2 || affected.length >= 2 || (affectedFilesSet.size >= 1 && !affectedFilesSet.has(targetNode.filePath))) {
      riskLevel = "medium";
    }

    return {
      targetSymbol: targetNode.name,
      targetFile: targetNode.filePath,
      affectedSymbols: affected,
      affectedFiles: [...affectedFilesSet],
      riskLevel,
      directCallersCount,
    };
  }

  generateRepoMap(maxChars = 2000): string {
    const fileEntries = new Map<string, CodeSymbolNode[]>();
    for (const sym of this.nodes.values()) {
      if (!sym.isExported) continue;
      const list = fileEntries.get(sym.filePath) ?? [];
      list.push(sym);
      fileEntries.set(sym.filePath, list);
    }

    const lines: string[] = ["# Codebase Symbol Outline (RepoMap)"];
    let currentLength = lines[0]?.length ?? 0;

    for (const [file, symbols] of fileEntries) {
      const header = `\n## ${file}`;
      if (currentLength + header.length > maxChars) break;
      lines.push(header);
      currentLength += header.length;

      for (const sym of symbols) {
        const entry = `  - ${sym.kind} ${sym.name}: ${sym.signature}`;
        if (currentLength + entry.length + 1 > maxChars) break;
        lines.push(entry);
        currentLength += entry.length + 1;
      }
    }

    return lines.join("\n");
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }
}

export const globalCodeGraph = new CodePropertyGraph();
