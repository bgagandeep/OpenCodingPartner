import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { deleteSandboxFile, mkdirSandboxDir, renameSandboxFile, rmdirSandboxDir, securityGate, writeSandboxFile } from "@opencodingpartner/workers";

export interface BridgeWriteBody {
  relativePath?: unknown;
  content?: unknown;
}

export interface BridgeWriteResult {
  ok: boolean;
  detail: string;
}

export interface BridgeDeleteBody {
  relativePath?: unknown;
}

export interface BridgeRenameBody {
  from?: unknown;
  to?: unknown;
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

/** Unlink one sandbox file. This is the only place the bridge deletes. */
export async function applyBridgeDelete(sandboxRoot: string, body: BridgeDeleteBody): Promise<BridgeWriteResult> {
  if (typeof body.relativePath !== "string") {
    return { ok: false, detail: "Delete bridge needs relativePath." };
  }
  const removed = await deleteSandboxFile(sandboxRoot, body.relativePath);
  return removed.ok
    ? { ok: true, detail: "Delete bridge removed the file." }
    : { ok: false, detail: removed.detail };
}

/** Create one sandbox directory. This is the only place the bridge creates directories. */
export async function applyBridgeMkdir(sandboxRoot: string, body: BridgeDeleteBody): Promise<BridgeWriteResult> {
  if (typeof body.relativePath !== "string") {
    return { ok: false, detail: "Mkdir bridge needs relativePath." };
  }
  const made = await mkdirSandboxDir(sandboxRoot, body.relativePath);
  return made.ok
    ? { ok: true, detail: "Mkdir bridge created the directory." }
    : { ok: false, detail: made.detail };
}

/** Remove one empty sandbox directory. This is the only place the bridge removes directories. */
export async function applyBridgeRmdir(sandboxRoot: string, body: BridgeDeleteBody): Promise<BridgeWriteResult> {
  if (typeof body.relativePath !== "string") {
    return { ok: false, detail: "Rmdir bridge needs relativePath." };
  }
  const removed = await rmdirSandboxDir(sandboxRoot, body.relativePath);
  return removed.ok
    ? { ok: true, detail: "Rmdir bridge removed the directory." }
    : { ok: false, detail: removed.detail };
}

/** Move one sandbox file. This is the only place the bridge renames. */
export async function applyBridgeRename(sandboxRoot: string, body: BridgeRenameBody): Promise<BridgeWriteResult> {
  if (typeof body.from !== "string" || typeof body.to !== "string") {
    return { ok: false, detail: "Rename bridge needs from and to." };
  }
  const moved = await renameSandboxFile(sandboxRoot, body.from, body.to);
  return moved.ok
    ? { ok: true, detail: "Rename bridge moved the file." }
    : { ok: false, detail: moved.detail };
}

/** Local tool host. OpenClaw invokes it. The server binds loopback only. */
export async function startSandboxWriteBridge(sandboxRoot: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || (req.url !== "/write" && req.url !== "/delete" && req.url !== "/rename" && req.url !== "/mkdir" && req.url !== "/rmdir")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: BridgeWriteBody & BridgeDeleteBody & BridgeRenameBody = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeWriteBody & BridgeDeleteBody & BridgeRenameBody;
    } catch {
      body = {};
    }
    const result =
      req.url === "/delete"
        ? await applyBridgeDelete(sandboxRoot, body)
        : req.url === "/rename"
          ? await applyBridgeRename(sandboxRoot, body)
          : req.url === "/mkdir"
            ? await applyBridgeMkdir(sandboxRoot, body)
            : req.url === "/rmdir"
              ? await applyBridgeRmdir(sandboxRoot, body)
              : await applyBridgeWrite(sandboxRoot, body);
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
