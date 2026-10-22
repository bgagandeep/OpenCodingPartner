import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startProductApp } from "./server.js";
import {
  createVaultItem,
  deleteVaultItem,
  fillVaultLogin,
  publicVault,
  readVaultSecret,
  vaultFillInvocation,
  vaultMasterKeyMode,
} from "./vault.js";

const SECRET = "pw !@# vault-secret-unique";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ocp-vault-"));
}

function fileEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: root,
    HERMES_HOME: root,
    OCP_DATA_DIR: root,
    OCP_VAULT_BACKEND: "file",
  };
}

test("vault encrypts secrets in a local file and never returns them", async () => {
  const root = await tempRoot();
  const env = fileEnv(root);
  try {
    const created = await createVaultItem(root, { name: "GitHub", kind: "login", account: "octocat", secret: SECRET }, env);
    assert.equal(created.name, "GitHub");
    assert.equal(created.account, "octocat");
    assert.equal("secret" in created, false);
    const status = await publicVault(root, env);
    assert.equal(status.backend, "encrypted-file");
    assert.match(status.backendLabel, /master key file/);
    assert.equal(status.items.length, 1);
    assert.equal(JSON.stringify(status).includes(SECRET), false);
    const disk = await readFile(path.join(root, "vault.enc"), "utf8");
    assert.equal(disk.includes(SECRET), false);
    assert.equal(await vaultMasterKeyMode(root), 0o600);
    assert.equal(await readVaultSecret(root, "GitHub", env), SECRET);
    await assert.rejects(() => createVaultItem(root, { name: "GitHub", kind: "login", account: "octocat", secret: SECRET }, env), /already exists/);
    await deleteVaultItem(root, created.id, env);
    assert.equal((await publicVault(root, env)).items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault fill types the secret without putting it in the result, and a 2FA page hands control to the human", async () => {
  const root = await tempRoot();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const env = fileEnv(root);
  try {
    await createVaultItem(root, { name: "GitHub", kind: "login", account: "octocat", secret: SECRET }, env);
    const typed: string[] = [];
    const filled = await fillVaultLogin({
      root,
      workspace,
      name: "GitHub",
      env,
      typeText: async (text) => {
        typed.push(text);
        return { ok: true, detail: `typed ${text}` };
      },
    });
    assert.deepEqual(typed, [SECRET]);
    assert.equal(filled.ok, true);
    assert.equal(filled.handoff, false);
    assert.match(filled.text, /Filled the password field for octocat from vault item GitHub/);
    assert.equal(filled.text.includes(SECRET), false);
    const leaked = await fillVaultLogin({
      root,
      workspace,
      name: "GitHub",
      env,
      typeText: async (text) => ({ ok: false, detail: `failed to type ${text}` }),
    });
    assert.equal(leaked.text.includes(SECRET), false);
    assert.match(leaked.text, /\[redacted\]/);
    let called = false;
    const handoff = await fillVaultLogin({
      root,
      workspace,
      name: "GitHub",
      challenge: "2fa",
      env,
      typeText: async () => {
        called = true;
        return { ok: true, detail: SECRET };
      },
    });
    assert.equal(called, false);
    assert.equal(handoff.ok, false);
    assert.equal(handoff.handoff, true);
    assert.match(handoff.text, /Take Control/);
    assert.match(handoff.text, /not typed/);
    assert.doesNotMatch(handoff.text, /Filled the password/);
    const desktop = await readFile(path.join(workspace, ".ocp", "computer-desktop.json"), "utf8");
    assert.match(desktop, /"control": "human"/);
    assert.equal(desktop.includes(SECRET), false);
    const titleArgs = vaultFillInvocation("vault_fill", { name: "GitHub", secret: SECRET, field: "password" });
    const title = `vault_fill(${Object.values(titleArgs ?? {}).slice(0, 2).map(String).join(", ").slice(0, 80)})`;
    assert.equal(title.includes(SECRET), false);
    assert.equal(JSON.stringify(titleArgs).includes(SECRET), false);
    const nested = vaultFillInvocation("tool_call", { name: "vault_fill", arguments: { name: "GitHub", secret: SECRET } });
    assert.equal(JSON.stringify(nested).includes(SECRET), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault uses a fake OS keychain and a fake 1Password CLI without a live account", async () => {
  const root = await tempRoot();
  const bin = path.join(root, "bin");
  const keychainFile = path.join(root, "keychain.txt");
  const opFile = path.join(root, "op-store.json");
  await mkdir(bin, { recursive: true });
  await writeFile(opFile, "{}\n");
  await writeFile(
    path.join(bin, "secret-tool"),
    `#!/bin/sh\nfile="$VAULT_KEYCHAIN_FILE"\nif [ "$1" = "lookup" ]; then\n  key=$(grep '^vault-master ' "$file" 2>/dev/null | cut -d' ' -f2-)\n  if [ -z "$key" ]; then exit 1; fi\n  printf '%s\\n' "$key"\n  exit 0\nfi\nif [ "$1" = "store" ]; then\n  key=$(cat)\n  printf 'vault-master %s\\n' "$key" > "$file"\n  exit 0\nfi\nexit 1\n`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, "secret-tool"), 0o755);
  await writeFile(
    path.join(bin, "op"),
    `#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from "node:fs";\nconst file = process.env.OP_STORE;\nconst store = JSON.parse(readFileSync(file, "utf8"));\nconst args = process.argv.slice(2);\nif (args[0] === "item" && args[1] === "get") {\n  const item = store[args[2]];\n  if (!item) process.exit(1);\n  process.stdout.write(item.password + "\\n");\n  process.exit(0);\n}\nif (args[0] === "item" && args[1] === "create") {\n  const parsed = JSON.parse(readFileSync(0, "utf8"));\n  store[parsed.title] = { password: parsed.fields.find((field) => field.purpose === "PASSWORD").value };\n  writeFileSync(file, JSON.stringify(store));\n  process.stdout.write("{}\\n");\n  process.exit(0);\n}\nif (args[0] === "item" && args[1] === "delete") {\n  delete store[args[2]];\n  writeFileSync(file, JSON.stringify(store));\n  process.exit(0);\n}\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );
  await chmod(path.join(bin, "op"), 0o755);
  const keychainEnv: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    OCP_VAULT_BACKEND: "keychain",
    VAULT_KEYCHAIN_FILE: keychainFile,
  };
  try {
    const created = await createVaultItem(root, { name: "Mail", kind: "oauth", account: "ada@example.com", secret: SECRET }, keychainEnv);
    assert.equal(created.storage, "local");
    const status = await publicVault(root, keychainEnv);
    assert.equal(status.backend, "os-keychain");
    assert.match(status.backendLabel, /OS keychain/);
    assert.equal(await vaultMasterKeyMode(root), undefined);
    const disk = await readFile(path.join(root, "vault.enc"), "utf8");
    assert.equal(disk.includes(SECRET), false);
    const chain = await readFile(keychainFile, "utf8");
    assert.equal(chain.includes(SECRET), false);
    assert.equal(await readVaultSecret(root, "Mail", keychainEnv), SECRET);

    const opEnv: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      OCP_VAULT_BACKEND: "file",
      OP_STORE: opFile,
    };
    const opItem = await createVaultItem(root, { name: "Outlook", kind: "login", account: "ada@example.com", secret: SECRET, storage: "1password" }, opEnv);
    assert.equal(opItem.storage, "1password");
    const opDisk = await readFile(path.join(root, "vault.enc"), "utf8");
    assert.equal(opDisk.includes(SECRET), false);
    const opStore = await readFile(opFile, "utf8");
    assert.equal(opStore.includes(SECRET), true);
    const typed: string[] = [];
    const filled = await fillVaultLogin({
      root,
      workspace: root,
      name: "Outlook",
      env: opEnv,
      typeText: async (text) => {
        typed.push(text);
        return { ok: true, detail: "typed" };
      },
    });
    assert.deepEqual(typed, [SECRET]);
    assert.equal(filled.text.includes(SECRET), false);
    await deleteVaultItem(root, opItem.id, opEnv);
    assert.equal((await readFile(opFile, "utf8")).includes(SECRET), false);

    const missing = path.join(root, "missing-op");
    await mkdir(missing, { recursive: true });
    await assert.rejects(
      () => createVaultItem(missing, { name: "Nope", kind: "token", account: "ada", secret: SECRET, storage: "1password" }, { ...fileEnv(missing), PATH: "/usr/bin:/bin" }),
      /not available/,
    );
    await assert.rejects(() => readFile(path.join(missing, "vault.enc"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault screen lists items without secrets and requires the app token to write", async () => {
  const root = await tempRoot();
  const env = fileEnv(root);
  const app = await startProductApp({ root, port: 0, env });
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /data-tab="vault"/);
    assert.match(html, /Take Control/);
    assert.match(html, /No vault items yet/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const scriptPath = path.join(root, "dash.js");
    await writeFile(scriptPath, script);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const denied = await fetch(`${app.url}/api/vault`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GitHub", kind: "login", account: "octocat", secret: SECRET }),
    });
    assert.equal(denied.status, 403);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const saved = await fetch(`${app.url}/api/vault`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "GitHub", kind: "login", account: "octocat", secret: SECRET }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 201);
    assert.equal(savedText.includes(SECRET), false);
    const stateRes = await fetch(`${app.url}/api/state`);
    const stateText = await stateRes.text();
    assert.equal(stateText.includes(SECRET), false);
    const state = JSON.parse(stateText) as { vault: { backend: string; items: Array<{ id: string; name: string }> } };
    assert.equal(state.vault.backend, "encrypted-file");
    assert.equal(state.vault.items[0]?.name, "GitHub");
    const removed = await fetch(`${app.url}/api/vault/${state.vault.items[0]!.id}`, { method: "DELETE", headers, body: "{}" });
    assert.equal(removed.status, 200);
    const after = (await (await fetch(`${app.url}/api/state`)).json()) as { vault: { items: unknown[] } };
    assert.equal(after.vault.items.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
