import assert from "node:assert/strict";
import test from "node:test";

import { PathRejectedError, isInsideSandbox, sanitizeRelativePath } from "./paths.js";

test("sanitizeRelativePath keeps a nested relative file", () => {
  assert.equal(sanitizeRelativePath("notes/hello.txt"), "notes/hello.txt");
});

test("sanitizeRelativePath rejects escape and absolute paths", () => {
  for (const candidate of ["../secret.txt", "/etc/passwd", "foo/../../secret.txt", ".", "C:/windows/note.txt"]) {
    assert.throws(() => sanitizeRelativePath(candidate), PathRejectedError);
  }
});

test("isInsideSandbox requires the file to stay under the root", () => {
  assert.equal(isInsideSandbox("/tmp/sandbox", "/tmp/sandbox/BOARD.md"), true);
  assert.equal(isInsideSandbox("/tmp/sandbox", "/tmp/other/BOARD.md"), false);
  assert.equal(isInsideSandbox("/tmp/sandbox", "/tmp/sandbox"), false);
});
