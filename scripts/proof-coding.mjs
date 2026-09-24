import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prompt = (await readFile(path.join(root, "examples/proof-multifile/PROMPT.txt"), "utf8")).trim();
const hasOpenAi = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);
const hasXai = Boolean(process.env.XAI_API_KEY);

process.stdout.write("Golden files you can open without a key:\n");
process.stdout.write("  examples/proof-multifile/src/math.ts\n");
process.stdout.write("  examples/proof-multifile/src/math.test.ts\n");

if (!hasOpenAi && !hasXai) {
  process.stdout.write(
    "No meter key is set. This command did not call a model and did not pretend to edit files.\nSet OPENAI_API_KEY and OPENAI_BASE_URL (LiteLLM or OpenRouter), or XAI_API_KEY, then run pnpm proof:coding again. That writes the files into .sandbox-proof/.\n",
  );
  process.exit(2);
}

const sandbox = path.join(root, ".sandbox-proof");
const child = spawn(
  process.execPath,
  [path.join(root, "packages/cli/dist/main.js"), "chat", "--sandbox", sandbox, prompt],
  { cwd: root, stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 1));
