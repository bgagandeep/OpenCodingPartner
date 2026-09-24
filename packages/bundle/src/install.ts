#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPins } from "./pins.js";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export function layaWeightPlan(root: string): string {
  const pins = loadPins();
  const python = path.join(root, ".bundle/laya/bin/python");
  const hfHome = path.join(root, ".bundle/laya/hf");
  return `HF_HOME=${hfHome} ${python} -c "from laya import Router; Router().predict('hello', [{'id':'route','type':'choice','text':'Which route?','options':['multi-agent','status']}], model='${pins.laya.checkpoint}')"`;
}

export function installPlan(root: string, layaOnly = false): string[] {
  const pins = loadPins();
  const openclawDir = path.join(root, ".bundle/openclaw");
  const grokDir = path.join(root, ".bundle/grok");
  const layaDir = path.join(root, ".bundle/laya");
  const layaSteps = [
    `python3 -m venv ${layaDir}`,
    `${path.join(layaDir, "bin/python")} -m pip install ${pins.laya.pypi}==${pins.laya.version}`,
    layaWeightPlan(root),
  ];
  if (layaOnly) return layaSteps;
  return [
    `npm install --prefix ${openclawDir} ${pins.openclaw.npm}@${pins.openclaw.version}`,
    `npm install --prefix ${grokDir} ${pins.grokBuild.npm}@${pins.grokBuild.version}`,
    ...layaSteps,
    `docker compose -f ${path.join(root, "docker-compose.yml")} up -d openclaw-gateway`,
  ];
}

export async function installBundle(root: string, dryRun: boolean, layaOnly = false): Promise<number> {
  const pins = loadPins();
  const plan = installPlan(root, layaOnly);
  if (dryRun) {
    process.stdout.write(`${plan.join("\n")}\n`);
    process.stdout.write(`${pins.laya.weightNote}\n`);
    process.stdout.write("Dry run. Nothing was installed.\n");
    return 0;
  }
  const openclawDir = path.join(root, ".bundle/openclaw");
  const grokDir = path.join(root, ".bundle/grok");
  const layaDir = path.join(root, ".bundle/laya");
  const hfHome = path.join(layaDir, "hf");
  if (!layaOnly) {
    await mkdir(openclawDir, { recursive: true });
    await mkdir(grokDir, { recursive: true });
    const openclawCode = await run("npm", ["install", "--prefix", openclawDir, `${pins.openclaw.npm}@${pins.openclaw.version}`], root);
    if (openclawCode !== 0) return openclawCode;
    const grokCode = await run("npm", ["install", "--prefix", grokDir, `${pins.grokBuild.npm}@${pins.grokBuild.version}`], root);
    if (grokCode !== 0) return grokCode;
  }
  const venvCode = await run("python3", ["-m", "venv", layaDir], root);
  if (venvCode !== 0) return venvCode;
  const pipCode = await run(path.join(layaDir, "bin/python"), ["-m", "pip", "install", `${pins.laya.pypi}==${pins.laya.version}`], root);
  if (pipCode !== 0) return pipCode;
  await mkdir(hfHome, { recursive: true });
  const weightCode = await run(
    path.join(layaDir, "bin/python"),
    ["-c", `from laya import Router; Router().predict("hello", [{"id":"route","type":"choice","text":"Which route?","options":["multi-agent","status"]}], model="${pins.laya.checkpoint}")\nprint("laya-weights-ready")`],
    root,
    { ...process.env, HF_HOME: hfHome },
  );
  if (weightCode !== 0) return weightCode;
  const stack = {
    openclawBin: path.join(openclawDir, "node_modules/.bin/openclaw"),
    grokBin: path.join(grokDir, "node_modules/.bin/grok"),
    layaPython: path.join(layaDir, "bin/python"),
    layaHfHome: hfHome,
    pins,
  };
  await mkdir(path.join(root, ".bundle"), { recursive: true });
  await writeFile(path.join(root, ".bundle/stack.json"), `${JSON.stringify(stack, null, 2)}\n`);
  process.stdout.write("Installed Laya and the English checkpoint under .bundle/laya/.\n");
  process.stdout.write(`${pins.laya.weightNote}\n`);
  if (!layaOnly) {
    process.stdout.write("Installed OpenClaw and Grok Build under .bundle/.\n");
    process.stdout.write("Their license files stay inside those installs. This repo did not copy their source.\n");
    process.stdout.write("Optional gateway: docker compose up -d openclaw-gateway\n");
  }
  process.stdout.write("Next chat turn uses this Laya. The transcript says System-1: real Laya.\n");
  return 0;
}

const isDirect = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const dryRun = process.argv.includes("--dry-run");
  const layaOnly = process.argv.includes("--laya-only");
  installBundle(repoRoot(), dryRun, layaOnly).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
