import assert from "node:assert/strict";
import test from "node:test";
import { runChatRepl } from "./repl.js";

test("the repl prints one transcript per message and stops on exit", async () => {
  const lines = ["Use Grok Build to create hello.txt with content:\nhello\n", "exit"];
  let out = "";
  const seen: string[] = [];
  const code = await runChatRepl({
    read: async () => lines.shift() ?? null,
    write: (text) => {
      out += text;
    },
    turn: async (message) => {
      seen.push(message);
      return { transcript: `Turn for ${message.split("\n")[0]}\nCoding agent wrote hello.txt\n` };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.match(out, /Coding agent wrote hello.txt/);
  assert.match(out, /Type exit to stop/);
  assert.match(out, /End a line with \\ to continue/);
});

test("a continued chat line keeps the next line in the same turn", async () => {
  const lines = ["Use the coding worker to create hello.txt with content:\\", "hello", "exit"];
  let out = "";
  const seen: string[] = [];
  const code = await runChatRepl({
    read: async () => lines.shift() ?? null,
    write: (text) => {
      out += text;
    },
    turn: async (message) => {
      seen.push(message);
      return { transcript: "Turn done\n" };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ["Use the coding worker to create hello.txt with content:\nhello"]);
  assert.match(out, /\.\.\. /);
  assert.match(out, /Turn done/);
});
