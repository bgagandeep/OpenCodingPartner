import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { securityGate, writeSandboxFile } from "@opencodingpartner/workers";

export interface BridgeWriteBody {
  relativePath?: unknown;
  content?: unknown;
}

export interface BridgeWriteResult {
  ok: boolean;
  detail: string;
}

/** Security gate, then a sandbox write. This is the only place the bridge writes. */
export async function applyBridgeWrite(sandboxRoot: string, body: BridgeWriteBody): Promise<BridgeWriteResult> {
  if (typeof body.relativePath !== "string" || typeof body.content !== "string") {
    return { ok: false, detail: "Write bridge needs relativePath and content." };
  }
  const gate = securityGate({ relativePath: body.relativePath, content: body.content, sandboxRoot });
  if (!gate.allow) {
    return { ok: false, detail: `Security gate blocked the write (${gate.reasons.join(", ")}).` };
  }
  await writeSandboxFile(sandboxRoot, body.relativePath, body.content);
  return { ok: true, detail: "Write bridge landed the file." };
}

/** Local tool host. OpenClaw invokes it. The server binds loopback only. */
export async function startSandboxWriteBridge(sandboxRoot: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/write") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: BridgeWriteBody = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeWriteBody;
    } catch {
      body = {};
    }
    const result = await applyBridgeWrite(sandboxRoot, body);
    res.writeHead(result.ok ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/write`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
