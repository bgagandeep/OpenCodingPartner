import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderSkillMarkdown } from "./skills.js";
import { startProductApp } from "./server.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "OCP Test", GIT_AUTHOR_EMAIL: "ocp@example.com", GIT_COMMITTER_NAME: "OCP Test", GIT_COMMITTER_EMAIL: "ocp@example.com" },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("skills can be edited, packed, loaded through tool search, and imported from a local git repo", async () => {
  const root = await tempDir("ocp-skills-");
  const workspace = await tempDir("ocp-skills-ws-");
  const app = await startProductApp({
    root,
    port: 0,
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root, OCP_VAULT_BACKEND: "file" },
  });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./workspace-mcp.js", import.meta.url)), workspace], {
    env: { PATH: process.env.PATH, HOME: root, HERMES_HOME: root, OCP_DATA_DIR: root, OCP_VAULT_BACKEND: "file" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  const rpc = async (id: number, name: string, args: Record<string, unknown>) => {
    output = "";
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const started = Date.now();
    while (!output.includes("\n") && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 20));
    return JSON.parse(output.split("\n")[0] ?? "{}") as { result?: { content?: Array<{ text?: string }> } };
  };
  try {
    const html = await (await fetch(app.url)).text();
    assert.match(html, /data-tab="skills"/);
    assert.match(html, /When to use/);
    assert.match(html, /A bot loads one on demand through tool search/);
    const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const scriptPath = path.join(root, "dash.js");
    await writeFile(scriptPath, script);
    const checked = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    const token = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(app.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const headers = { "content-type": "application/json", "x-ocp-token": token };
    const state = await (await fetch(`${app.url}/api/state`)).json() as { skills: Array<{ id: string; name: string; whenToUse: string; body: string }> };
    assert.equal(state.skills.length, 3);
    assert.ok(state.skills.some((skill) => skill.name === "Review a diff"));
    const refused = await fetch(`${app.url}/api/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 403);

    const created = await fetch(`${app.url}/api/skills`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ship a note", whenToUse: "Write a short note after tests pass.", body: "1. Quote the test output.\n2. Stop." }),
    });
    assert.equal(created.status, 201);
    const duplicate = await fetch(`${app.url}/api/skills`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ship a note", whenToUse: "Again.", body: "1. No." }),
    });
    assert.equal(duplicate.status, 409);
    const edited = await fetch(`${app.url}/api/skills/ship-a-note`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Ship a note", whenToUse: "Write a short note after tests pass.", body: "1. Quote the test output.\n2. Do not invent a result." }),
    });
    assert.equal(edited.status, 200);

    const found = await rpc(1, "tool_search", { query: "failing test" });
    const foundText = found.result?.content?.[0]?.text ?? "";
    assert.match(foundText, /skill:reproduce-a-bug/);
    assert.match(foundText, /smallest test that fails/);
    const described = await rpc(2, "tool_describe", { name: "skill:explain-a-change" });
    assert.match(described.result?.content?.[0]?.text ?? "", /Do not invent a result/);

    const exported = await fetch(`${app.url}/api/skills/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /zip/);
    const zip = Buffer.from(await exported.arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString("utf8"), "PK");
    const other = await tempDir("ocp-skills-import-");
    const otherApp = await startProductApp({
      root: other,
      port: 0,
      env: { PATH: process.env.PATH, HOME: other, HERMES_HOME: other, OCP_DATA_DIR: other, OCP_VAULT_BACKEND: "file" },
    });
    try {
      const otherToken = /script-src 'nonce-([a-f0-9]+)'/.exec((await fetch(otherApp.url)).headers.get("content-security-policy") ?? "")?.[1] ?? "";
      const imported = await fetch(`${otherApp.url}/api/skills/import`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ocp-token": otherToken },
        body: JSON.stringify({ zipBase64: zip.toString("base64") }),
      });
      const importedText = await imported.text();
      assert.equal(imported.status, 200, importedText);
      assert.match(importedText, /"imported":4/);
      const otherState = await (await fetch(`${otherApp.url}/api/state`)).json() as { skills: Array<{ name: string; body: string }> };
      assert.equal(otherState.skills.find((skill) => skill.name === "Ship a note")?.body.includes("Do not invent a result"), true);
    } finally {
      await otherApp.close();
      await rm(other, { recursive: true, force: true });
    }

    const repo = await tempDir("ocp-skills-git-");
    await writeFile(path.join(repo, "SKILL.md"), renderSkillMarkdown({
      name: "Local pack skill",
      whenToUse: "Loaded from a local git repository.",
      body: "1. Read this step from the local pack.",
      builtin: false,
    }));
    git(repo, ["init"]);
    git(repo, ["add", "SKILL.md"]);
    git(repo, ["commit", "-m", "add skill"]);
    const fromGit = await fetch(`${app.url}/api/skills/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gitUrl: repo }),
    });
    const fromGitText = await fromGit.text();
    assert.equal(fromGit.status, 200, fromGitText);
    const afterGit = await (await fetch(`${app.url}/api/state`)).text();
    assert.match(afterGit, /Local pack skill/);
    assert.equal(afterGit.includes("ocp@example.com"), false);

    const removed = await fetch(`${app.url}/api/skills/ship-a-note`, { method: "DELETE", headers, body: "{}" });
    assert.equal(removed.status, 200);
    const remaining = await (await fetch(`${app.url}/api/state`)).json() as { skills: Array<{ id: string }> };
    assert.equal(remaining.skills.some((skill) => skill.id === "ship-a-note"), false);
    await rm(repo, { recursive: true, force: true });
  } finally {
    child.kill("SIGKILL");
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
