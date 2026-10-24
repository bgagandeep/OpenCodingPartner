import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startProductApp } from "./server.js";

function status(url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers,
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("the app refuses a public bind, a foreign origin, and a tokenless write", async () => {
  await assert.rejects(() => startProductApp({ host: "0.0.0.0", port: 0 }), /loopback/);
  await assert.rejects(() => startProductApp({ host: "10.1.2.3", port: 0 }), /loopback/);

  const root = await mkdtemp(path.join(tmpdir(), "ocp-loop-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root };
  const app = await startProductApp({ root, port: 0, env });
  try {
    const port = new URL(app.url).port;
    assert.equal(await status(app.url, { host: `127.0.0.1:${port}` }), 200);
    assert.equal(await status(app.url, { host: `127.0.0.1:${port}`, origin: "https://example.com" }), 403);
    assert.equal(await status(app.url, { host: "evil.example" }), 403);
    assert.equal(await status(`${app.url}/api/settings`, {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
    }, "POST", JSON.stringify({ theme: "light" })), 403);
    const html = await (await fetch(app.url)).text();
    assert.match(html, /<html lang="en" data-theme="dark">/);

    const tracesRes = await fetch(`${app.url}/api/telemetry/traces`);
    assert.equal(tracesRes.status, 200);
    const tracesJson = await tracesRes.json() as { mode: string; traces: unknown[] };
    assert.ok(tracesJson.mode);

    const modeRes = await fetch(`${app.url}/api/telemetry/mode`);
    assert.equal(modeRes.status, 200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
