import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  globalTracer,
  listPersistedTraces,
  loadPersistedTrace,
  persistTrace,
} from "./telemetry.js";

test("telemetry tracer lifecycle and metrics aggregation", () => {
  globalTracer.clear();
  globalTracer.setMode("standard");

  const trace = globalTracer.startTrace("task:test-run", {
    taskId: "task-123",
    botId: "bot-linus",
  });
  assert.ok(trace);
  assert.equal(trace.name, "task:test-run");
  assert.equal(trace.status, "running");

  // Child span: model call
  const modelSpan = globalTracer.startSpan(trace.traceId, "model:generate", {
    kind: "client",
    attributes: {
      "gen_ai.operation.name": "model_generate",
      "gen_ai.request.model": "anthropic/claude-3-7-sonnet",
    },
  });
  assert.ok(modelSpan);

  globalTracer.endSpan(trace.traceId, modelSpan.id, {
    status: "ok",
    attributes: {
      "gen_ai.usage.input_tokens": 1500,
      "gen_ai.usage.output_tokens": 400,
      "gen_ai.usage.cost_usd": 0.0105,
    },
  });

  // Child span: tool call
  const toolSpan = globalTracer.startSpan(trace.traceId, "tool:workspace_patch", {
    parentSpanId: trace.rootSpanId,
    attributes: {
      "gen_ai.operation.name": "tool_call",
      "gen_ai.tool.name": "workspace_patch",
    },
  });
  assert.ok(toolSpan);

  globalTracer.recordEvent(trace.traceId, toolSpan.id, "diff_applied", { path: "src/auth.ts" });
  globalTracer.endSpan(trace.traceId, toolSpan.id, { status: "ok" });

  const completed = globalTracer.endTrace(trace.traceId, { status: "ok" });
  assert.ok(completed);
  assert.equal(completed.status, "ok");
  assert.equal(completed.metrics.inputTokens, 1500);
  assert.equal(completed.metrics.outputTokens, 400);
  assert.equal(completed.metrics.costUsd, 0.0105);
  assert.equal(completed.metrics.modelCallCount, 1);
  assert.equal(completed.metrics.toolCallCount, 1);

  // Flamegraph representation
  const flamegraph = globalTracer.toFlamegraph(trace.traceId);
  assert.ok(flamegraph);
  assert.equal(flamegraph.name, "task:test-run");
  assert.equal(flamegraph.children.length, 2);
});

test("telemetry tracer off mode suppresses spans", () => {
  globalTracer.clear();
  globalTracer.setMode("off");

  const trace = globalTracer.startTrace("task:silent");
  assert.equal(trace, undefined);
  assert.equal(globalTracer.getRecentTraces().length, 0);

  globalTracer.setMode("standard");
});

test("telemetry persistence save and load", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "ocp-telemetry-test-"));
  try {
    globalTracer.clear();
    globalTracer.setMode("deep");

    const trace = globalTracer.startTrace("task:persist-check", { taskId: "t-999" });
    assert.ok(trace);
    globalTracer.endTrace(trace.traceId, { status: "ok" });

    const savedFile = await persistTrace(tmp, trace);
    assert.ok(savedFile.endsWith(`${trace.traceId}.json`));

    const loaded = await loadPersistedTrace(tmp, trace.traceId);
    assert.ok(loaded);
    assert.equal(loaded.traceId, trace.traceId);
    assert.equal(loaded.taskId, "t-999");

    const list = await listPersistedTraces(tmp);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.traceId, trace.traceId);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
