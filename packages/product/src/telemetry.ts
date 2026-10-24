import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

export type ObservabilityMode = "off" | "standard" | "deep";

export interface SpanEvent {
  name: string;
  timestampMs: number;
  attributes?: Record<string, unknown>;
}

export interface TelemetrySpan {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client" | "server";
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface TelemetryTrace {
  traceId: string;
  rootSpanId: string;
  taskId?: string;
  botId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: "ok" | "error" | "running";
  spans: TelemetrySpan[];
  metrics: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCallCount: number;
    modelCallCount: number;
  };
}

export interface FlamegraphNode {
  id: string;
  name: string;
  value: number; // durationMs
  startTimeMs: number;
  endTimeMs: number;
  status: "ok" | "error" | "running";
  attributes: Record<string, unknown>;
  children: FlamegraphNode[];
}

const TRACE_BUFFER_LIMIT = 100;

class TelemetryTracer {
  private mode: ObservabilityMode = "standard";
  private activeTraces = new Map<string, TelemetryTrace>();
  private completedTraces: TelemetryTrace[] = [];

  constructor(mode?: ObservabilityMode) {
    if (mode) this.mode = mode;
  }

  getMode(): ObservabilityMode {
    return this.mode;
  }

  setMode(mode: ObservabilityMode): void {
    this.mode = mode;
  }

  startTrace(name: string, options: { taskId?: string; botId?: string; attributes?: Record<string, unknown> } = {}): TelemetryTrace | undefined {
    if (this.mode === "off") return undefined;

    const traceId = randomUUID();
    const rootSpanId = randomUUID();
    const now = Date.now();

    const rootSpan: TelemetrySpan = {
      id: rootSpanId,
      traceId,
      name,
      kind: "server",
      startTimeMs: now,
      status: "unset",
      attributes: {
        "gen_ai.system": "opencodingpartner",
        "gen_ai.task.id": options.taskId,
        "gen_ai.agent.id": options.botId,
        ...(options.attributes ?? {}),
      },
      events: [],
    };

    const trace: TelemetryTrace = {
      traceId,
      rootSpanId,
      taskId: options.taskId,
      botId: options.botId,
      name,
      startTimeMs: now,
      status: "running",
      spans: [rootSpan],
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCallCount: 0,
        modelCallCount: 0,
      },
    };

    this.activeTraces.set(traceId, trace);
    return trace;
  }

  startSpan(traceId: string, name: string, options: { parentSpanId?: string; kind?: TelemetrySpan["kind"]; attributes?: Record<string, unknown> } = {}): TelemetrySpan | undefined {
    if (this.mode === "off") return undefined;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return undefined;

    const span: TelemetrySpan = {
      id: randomUUID(),
      traceId,
      parentSpanId: options.parentSpanId ?? trace.rootSpanId,
      name,
      kind: options.kind ?? "internal",
      startTimeMs: Date.now(),
      status: "unset",
      attributes: options.attributes ?? {},
      events: [],
    };

    trace.spans.push(span);
    return span;
  }

  recordEvent(traceId: string, spanId: string, name: string, attributes?: Record<string, unknown>): void {
    if (this.mode === "off") return;
    const trace = this.activeTraces.get(traceId);
    if (!trace) return;
    const span = trace.spans.find((s) => s.id === spanId);
    if (!span) return;
    span.events.push({
      name,
      timestampMs: Date.now(),
      attributes,
    });
  }

  endSpan(traceId: string, spanId: string, options: { status?: "ok" | "error"; statusMessage?: string; attributes?: Record<string, unknown> } = {}): void {
    if (this.mode === "off") return;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find((s) => s.id === spanId);
    if (!span || span.endTimeMs !== undefined) return;

    span.endTimeMs = Date.now();
    span.durationMs = Math.max(0, span.endTimeMs - span.startTimeMs);
    span.status = options.status ?? "ok";
    if (options.statusMessage) span.statusMessage = options.statusMessage;
    if (options.attributes) {
      Object.assign(span.attributes, options.attributes);
    }

    // Extract GenAI metrics if present
    const inTokens = Number(span.attributes["gen_ai.usage.input_tokens"]);
    const outTokens = Number(span.attributes["gen_ai.usage.output_tokens"]);
    const cost = Number(span.attributes["gen_ai.usage.cost_usd"]);
    if (Number.isFinite(inTokens) && inTokens > 0) trace.metrics.inputTokens += inTokens;
    if (Number.isFinite(outTokens) && outTokens > 0) trace.metrics.outputTokens += outTokens;
    if (Number.isFinite(cost) && cost > 0) trace.metrics.costUsd += cost;

    if (span.name.startsWith("tool:") || span.attributes["gen_ai.operation.name"] === "tool_call") {
      trace.metrics.toolCallCount += 1;
    }
    if (span.name.startsWith("model:") || span.attributes["gen_ai.operation.name"] === "model_generate") {
      trace.metrics.modelCallCount += 1;
    }
  }

  endTrace(traceId: string, options: { status?: "ok" | "error"; error?: string } = {}): TelemetryTrace | undefined {
    if (this.mode === "off") return undefined;

    const trace = this.activeTraces.get(traceId);
    if (!trace) return undefined;

    const now = Date.now();
    trace.endTimeMs = now;
    trace.durationMs = Math.max(0, now - trace.startTimeMs);
    trace.status = options.status ?? (options.error ? "error" : "ok");

    // Close any unclosed spans
    for (const span of trace.spans) {
      if (span.endTimeMs === undefined) {
        span.endTimeMs = now;
        span.durationMs = Math.max(0, now - span.startTimeMs);
        if (span.status === "unset") span.status = trace.status === "error" ? "error" : "ok";
      }
    }

    this.activeTraces.delete(traceId);
    this.completedTraces.unshift(trace);
    if (this.completedTraces.length > TRACE_BUFFER_LIMIT) {
      this.completedTraces.pop();
    }

    return trace;
  }

  getRecentTraces(limit = 20): TelemetryTrace[] {
    return this.completedTraces.slice(0, limit);
  }

  getTrace(traceId: string): TelemetryTrace | undefined {
    return this.activeTraces.get(traceId) ?? this.completedTraces.find((t) => t.traceId === traceId);
  }

  toFlamegraph(traceId: string): FlamegraphNode | undefined {
    const trace = this.getTrace(traceId);
    if (!trace || trace.spans.length === 0) return undefined;

    const spanMap = new Map<string, TelemetrySpan>();
    const childrenMap = new Map<string, TelemetrySpan[]>();

    for (const span of trace.spans) {
      spanMap.set(span.id, span);
      const parent = span.parentSpanId ?? "";
      const siblings = childrenMap.get(parent) ?? [];
      siblings.push(span);
      childrenMap.set(parent, siblings);
    }

    const rootSpan = spanMap.get(trace.rootSpanId) ?? trace.spans[0];
    if (!rootSpan) return undefined;

    const buildNode = (span: TelemetrySpan): FlamegraphNode => {
      const children = (childrenMap.get(span.id) ?? [])
        .sort((a, b) => a.startTimeMs - b.startTimeMs)
        .map(buildNode);

      return {
        id: span.id,
        name: span.name,
        value: span.durationMs ?? 0,
        startTimeMs: span.startTimeMs,
        endTimeMs: span.endTimeMs ?? Date.now(),
        status: span.status === "unset" ? "running" : span.status,
        attributes: span.attributes,
        children,
      };
    };

    return buildNode(rootSpan);
  }

  clear(): void {
    this.activeTraces.clear();
    this.completedTraces = [];
  }
}

export const globalTracer = new TelemetryTracer();

export function tracesDir(rootDataDir: string): string {
  return path.join(rootDataDir, "traces");
}

export async function persistTrace(rootDataDir: string, trace: TelemetryTrace): Promise<string> {
  const dir = tracesDir(rootDataDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${trace.traceId}.json`);
  await writeFile(file, JSON.stringify(trace, null, 2), "utf8");
  return file;
}

export async function loadPersistedTrace(rootDataDir: string, traceId: string): Promise<TelemetryTrace | undefined> {
  const file = path.join(tracesDir(rootDataDir), `${traceId}.json`);
  try {
    const content = await readFile(file, "utf8");
    return JSON.parse(content) as TelemetryTrace;
  } catch {
    return undefined;
  }
}

export async function listPersistedTraces(rootDataDir: string, limit = 50): Promise<Array<{ traceId: string; name: string; durationMs: number; status: string; startTimeMs: number }>> {
  const dir = tracesDir(rootDataDir);
  try {
    const entries = await readdir(dir);
    const results: Array<{ traceId: string; name: string; durationMs: number; status: string; startTimeMs: number }> = [];

    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const content = await readFile(file, "utf8");
        const parsed = JSON.parse(content) as TelemetryTrace;
        results.push({
          traceId: parsed.traceId,
          name: parsed.name,
          durationMs: parsed.durationMs ?? 0,
          status: parsed.status,
          startTimeMs: parsed.startTimeMs,
        });
      } catch {
        // Skip malformed trace files
      }
    }

    return results.sort((a, b) => b.startTimeMs - a.startTimeMs).slice(0, limit);
  } catch {
    return [];
  }
}
