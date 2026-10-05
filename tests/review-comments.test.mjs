import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { commentInput, commentIsOnDisplayedSide, wholeLineRange } from "../lib/review-comments.ts";

const before = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const after = before.replace("line 10\n", "changed 10\n").replace("line 90\n", "changed 90\n");
const full = parseDiffFromFile({ name: "f.c", contents: before }, { name: "f.c", contents: after });
const partial = parsePatchFiles("diff --git a/f.c b/f.c\n--- a/f.c\n+++ b/f.c\n@@ -9,3 +9,3 @@\n line 9\n-line 10\n+changed 10\n line 11\n")[0].files[0];
const selection = (start, end, side = "additions") => ({ start, end, side, endSide: side });
const comment = (range, extra = {}) => ({ key: "draft", path: "f.c", message: "Review", range, ...extra });

test("expanded gutter ranges retain both endpoints on either side, outside hunks", () => {
  for (const side of ["additions", "deletions"]) {
    const range = selection(39, 40, side);
    const textRange = wholeLineRange(range, full);
    assert.deepEqual(textRange, { start_line: 39, start_character: 0, end_line: 40, end_character: 7 });
    assert.deepEqual(wholeLineRange(selection(40, 39, side), full), textRange);
    // The draft captures the live expanded item; publishing still sees the original patch.
    assert.deepEqual(commentInput(comment(range, { textRange }), partial, 0), {
      side: side === "deletions" ? "PARENT" : "REVISION", message: "Review", range: textRange,
    });
    assert.deepEqual(commentInput(comment(range), full, 0).range, textRange);
  }
});

test("partial hunks and full repository files use the correct line indices and character lengths", () => {
  assert.equal(wholeLineRange(selection(9, 10), partial).end_character, "changed 10".length);
  assert.equal(wholeLineRange(selection(9, 10, "deletions"), partial).end_character, "line 10".length);
  const file = { name: "repo.c", contents: "first\r\nlast\r\n" };
  assert.deepEqual(wholeLineRange(selection(1, 2), file), { start_line: 1, start_character: 0, end_line: 2, end_character: 4 });
  assert.equal(wholeLineRange(selection(39, 40), partial), undefined);
  assert.throws(() => commentInput(comment(selection(39, 40)), partial, 0), /range content is unavailable/);
});

test("commit-message offsets, exact replies, and patchset-level comments are preserved", () => {
  const range = selection(1, 2);
  const textRange = wholeLineRange(range, { name: "Commit message", contents: "Subject\nBody" });
  assert.deepEqual(commentInput(comment(range, { path: "/COMMIT_MSG", textRange }), undefined, 6).range, {
    start_line: 7, start_character: 0, end_line: 8, end_character: 4,
  });
  const gerritRange = { start_line: 1, start_character: 2, end_line: 2, end_character: 3 };
  assert.deepEqual(commentInput(comment(range, { path: "/COMMIT_MSG", textRange, gerritRange, inReplyTo: "id" }), undefined, 6).range, gerritRange);
  assert.deepEqual(commentInput(comment(selection(0, 0), { path: "/PATCHSET_LEVEL", unresolved: true }), undefined, 6), { message: "Review", unresolved: true });
  assert.equal(commentInput(comment(selection(40, 40)), partial, 0).line, 40);
});

test("parent-side comments are never anchored to a different patchset's content", () => {
  for (const ported of [false, true]) {
    const parent = { side: "PARENT", path: "f.c", ported };
    assert.equal(commentIsOnDisplayedSide(parent), true);
    assert.equal(commentIsOnDisplayedSide(parent, 1), false);
    assert.equal(commentIsOnDisplayedSide({ ...parent, side: "REVISION" }, 1), true);
    assert.equal(commentIsOnDisplayedSide({ ...parent, path: "/COMMIT_MSG" }), false);
  }
});
