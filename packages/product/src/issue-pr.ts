import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTask, findBot, updateTask } from "./index.js";
import { readVaultSecret } from "./vault.js";

export class IssuePrError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface IssueRun {
  id: string;
  provider: "github" | "linear";
  issue: string;
  title: string;
  issueBody: string;
  repo: string;
  base: string;
  botId: string;
  taskId: string;
  githubVaultItem: string;
  status: "needs-plan" | "editing" | "pr-opened" | "failed";
  plan: string;
  planApproved: boolean;
  diffSummary?: string;
  testResults?: string;
  testExitCode?: number;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueFile { runs: IssueRun[] }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function filePath(root: string): string {
  return path.join(root, "issue-runs.json");
}

async function readRuns(root: string): Promise<IssueRun[]> {
  const text = await readFile(filePath(root), "utf8").catch(() => "");
  if (!text) return [];
  const parsed = JSON.parse(text) as IssueFile;
  return Array.isArray(parsed.runs) ? parsed.runs : [];
}

async function writeRuns(root: string, runs: IssueRun[]): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(filePath(root), `${JSON.stringify({ runs: runs.slice(-50) }, null, 2)}\n`, { mode: 0o600 });
}

export async function listIssueRuns(root: string): Promise<IssueRun[]> {
  return readRuns(root);
}

export async function startIssueRun(
  root: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueRun> {
  const provider = input.provider === "linear" ? "linear" : input.provider === "github" ? "github" : "";
  if (!provider) throw new IssuePrError("Choose GitHub or Linear.");
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  const base = typeof input.base === "string" && input.base.trim() ? input.base.trim() : "main";
  const issue = typeof input.issue === "string" ? input.issue.trim() : "";
  const vaultItem = typeof input.vaultItem === "string" ? input.vaultItem.trim() : "";
  const githubVaultItem = typeof input.githubVaultItem === "string" && input.githubVaultItem.trim()
    ? input.githubVaultItem.trim()
    : provider === "github" ? vaultItem : "";
  if (!REPO.test(repo)) throw new IssuePrError("Repository must look like owner/name.");
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(base)) throw new IssuePrError("Base branch name is invalid.");
  if (!vaultItem || !githubVaultItem) throw new IssuePrError("Name the vault item that holds the token. Nothing was fetched.");
  const bot = await findBot(typeof input.botId === "string" ? input.botId : "", root);
  if (!bot) throw new IssuePrError("Unknown bot.");
  const token = await readVaultSecret(root, vaultItem, env);
  if (!token) throw new IssuePrError("That vault item has no token. Nothing was fetched.");
  const fetched = provider === "github"
    ? await fetchGitHubIssue(repo, issue, token, env)
    : await fetchLinearIssue(issue, token, env);
  const plan = [
    "Plan drafted from the issue text. No model wrote this plan.",
    "",
    `Issue: ${fetched.issue}`,
    `Title: ${fetched.title}`,
    "",
    fetched.body || "The issue had no description.",
    "",
    "Stages:",
    "1. Approve this plan.",
    "2. Edit the workspace.",
    "3. Run tests and keep their output.",
    "4. Review the diff summary.",
    "5. Open a pull request that includes this plan, the diff summary, and the test output.",
    "6. Stop. Merging stays with a person.",
  ].join("\n");
  const safePlan = scrub(plan, token);
  const task = await createTask({
    botId: bot.id,
    prompt: safePlan.slice(0, 20_000),
  }, root);
  await updateTask(task.id, {
    status: "needs-attention",
    result: "Plan is waiting for approval. The pull request is not open.",
  }, root);
  const now = new Date().toISOString();
  const run: IssueRun = {
    id: randomUUID(),
    provider,
    issue: fetched.issue,
    title: scrub(fetched.title, token).slice(0, 200),
    issueBody: scrub(fetched.body, token).slice(0, 8_000),
    repo,
    base,
    botId: bot.id,
    taskId: task.id,
    githubVaultItem,
    status: "needs-plan",
    plan: safePlan.slice(0, 12_000),
    planApproved: false,
    createdAt: now,
    updatedAt: now,
  };
  const runs = await readRuns(root);
  runs.push(run);
  await writeRuns(root, runs);
  return run;
}

export async function approveIssuePlan(root: string, id: string): Promise<IssueRun> {
  const runs = await readRuns(root);
  const run = runs.find((item) => item.id === id);
  if (!run) throw new IssuePrError("Unknown issue run.", 404);
  if (run.status === "pr-opened") throw new IssuePrError("The pull request is already open.");
  run.planApproved = true;
  run.status = "editing";
  run.updatedAt = new Date().toISOString();
  run.error = undefined;
  await updateTask(run.taskId, {
    status: "needs-attention",
    result: "Plan approved. Edit the workspace, run tests, then open the pull request. OCP does not merge.",
  }, root);
  await writeRuns(root, runs);
  return run;
}

export async function runIssueTests(root: string, id: string): Promise<IssueRun> {
  const runs = await readRuns(root);
  const run = runs.find((item) => item.id === id);
  if (!run) throw new IssuePrError("Unknown issue run.", 404);
  if (!run.planApproved) throw new IssuePrError("Approve the plan before running tests. Nothing was run.");
  const bot = await findBot(run.botId, root);
  if (!bot) throw new IssuePrError("Unknown bot.");
  const result = await runCommand(bot.workspace, process.execPath, ["--test"], 20_000);
  run.testExitCode = result.code;
  run.testResults = result.output.slice(0, 8_000);
  run.updatedAt = new Date().toISOString();
  run.error = undefined;
  await writeRuns(root, runs);
  return run;
}

export async function openIssuePullRequest(
  root: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssueRun> {
  const runs = await readRuns(root);
  const run = runs.find((item) => item.id === id);
  if (!run) throw new IssuePrError("Unknown issue run.", 404);
  if (!run.planApproved) throw new IssuePrError("Approve the plan before opening a pull request. Nothing was opened.");
  if (run.testResults === undefined) throw new IssuePrError("Run tests before opening a pull request. Nothing was opened.");
  if (run.status === "pr-opened" && run.prUrl) throw new IssuePrError("A pull request is already open.");
  const bot = await findBot(run.botId, root);
  if (!bot) throw new IssuePrError("Unknown bot.");
  const diff = await workspaceDiff(bot.workspace);
  if (!diff.trim()) throw new IssuePrError("The workspace has no diff. The pull request was not opened.");
  const token = await readVaultSecret(root, run.githubVaultItem, env);
  if (!token) throw new IssuePrError("The GitHub token is not in the vault. The pull request was not opened.");
  const summary = scrub(diff, token).slice(0, 8_000);
  const tests = scrub(run.testResults, token);
  const passed = run.testExitCode === 0;
  const body = [
    "## Plan",
    scrub(run.plan, token),
    "",
    "## Diff",
    summary,
    "",
    "## Tests",
    passed ? "The test command exited 0." : `The test command exited ${run.testExitCode}. This is not a pass.`,
    "",
    tests,
    "",
    `Opened from ${run.provider} issue ${run.issue}. Merging stays with a person. OCP does not merge.`,
  ].join("\n");
  const head = `ocp/issue-${run.issue.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || run.id.slice(0, 8)}`;
  const opened = await createPullRequest(run.repo, token, {
    title: run.title.slice(0, 120),
    head,
    base: run.base,
    body: body.slice(0, 60_000),
    draft: true,
  }, env);
  run.diffSummary = summary;
  run.updatedAt = new Date().toISOString();
  if (!opened.ok || !opened.url) {
    run.status = "failed";
    run.error = opened.error || "The host rejected the pull request. Nothing was marked open.";
    run.prUrl = undefined;
    await updateTask(run.taskId, { status: "needs-attention", result: run.error, error: run.error }, root);
    await writeRuns(root, runs);
    return run;
  }
  run.status = "pr-opened";
  run.prUrl = scrub(opened.url, token);
  run.error = undefined;
  await updateTask(run.taskId, {
    status: "succeeded",
    result: `Pull request opened: ${run.prUrl}. It was not merged.`,
    error: undefined,
  }, root);
  await writeRuns(root, runs);
  return run;
}

async function fetchGitHubIssue(repo: string, issue: string, token: string, env: NodeJS.ProcessEnv): Promise<{ issue: string; title: string; body: string }> {
  const number = /#?(\d+)$/.exec(issue)?.[1] ?? "";
  if (!number) throw new IssuePrError("GitHub issue must be a number, like owner/name#12.");
  const response = await fetch(`${githubApi(env)}/repos/${repo}/issues/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "opencodingpartner" },
  });
  if (response.status === 404) throw new IssuePrError("The issue was not found. Nothing was started.");
  if (!response.ok) throw new IssuePrError("GitHub rejected the issue request. Nothing was started.");
  const payload = await response.json() as { title?: string; body?: string; number?: number };
  return { issue: `${repo}#${payload.number ?? number}`, title: payload.title || `Issue ${number}`, body: payload.body || "" };
}

async function fetchLinearIssue(issue: string, token: string, env: NodeJS.ProcessEnv): Promise<{ issue: string; title: string; body: string }> {
  if (!/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(issue)) throw new IssuePrError("Linear issue must look like TEAM-12.");
  const response = await fetch(linearApi(env), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: "query($term: String!) { searchIssues(term: $term, first: 1) { nodes { identifier title description url } } }",
      variables: { term: issue },
    }),
  });
  if (!response.ok) throw new IssuePrError("Linear rejected the issue request. Nothing was started.");
  const payload = await response.json() as { data?: { searchIssues?: { nodes?: Array<{ identifier?: string; title?: string; description?: string }> } } };
  const node = payload.data?.searchIssues?.nodes?.[0];
  if (!node?.title) throw new IssuePrError("The Linear issue was not found. Nothing was started.");
  return { issue: node.identifier || issue, title: node.title, body: node.description || "" };
}

async function createPullRequest(
  repo: string,
  token: string,
  body: { title: string; head: string; base: string; body: string; draft: boolean },
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const response = await fetch(`${githubApi(env)}/repos/${repo}/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "opencodingpartner" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: "The host rejected the pull request. Nothing was marked open." };
  const payload = await response.json() as { html_url?: string };
  if (!payload.html_url) return { ok: false, error: "The host did not return a pull request URL. Nothing was marked open." };
  return { ok: true, url: payload.html_url };
}

function githubApi(env: NodeJS.ProcessEnv): string {
  return (env.OCP_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
}

function linearApi(env: NodeJS.ProcessEnv): string {
  return env.OCP_LINEAR_API_URL || "https://api.linear.app/graphql";
}

async function workspaceDiff(workspace: string): Promise<string> {
  const status = await runCommand(workspace, "git", ["status", "--porcelain"], 8_000);
  const diff = await runCommand(workspace, "git", ["diff", "--", "."], 8_000);
  const staged = await runCommand(workspace, "git", ["diff", "--cached", "--", "."], 8_000);
  if (status.code !== 0) return "";
  return [`${status.output}`.trim(), diff.output.trim(), staged.output.trim()].filter(Boolean).join("\n\n");
}

function runCommand(cwd: string, command: string, args: string[], timeout: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, timeout, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (chunk: Buffer) => {
      if (output.length < 12_000) output += chunk.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", () => resolve({ code: 1, output: output || "The command could not start." }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function scrub(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}
