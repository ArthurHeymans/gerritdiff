import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewDraft, parseReviewEditorBuffers, reviewDraftKey } from "../lib/review-draft.ts";

const draft = {
  version: 1,
  comments: [{ key: "draft-1", path: "src/init.c", message: "Keep context", range: { start: 2, end: 3, side: "deletions", endSide: "deletions" }, textRange: { start_line: 2, start_character: 0, end_line: 3, end_character: 5 }, unresolved: true }],
  replies: [{ key: "gerrit:thread-1", message: "Done", resolved: true }],
  message: "Looks good", vote: "1",
};

test("draft recovery retains exact coordinates, replies, message and vote", () => {
  assert.deepEqual(parseReviewDraft(JSON.stringify(draft)), draft);
});

test("invalid or corrupt tab storage cannot become a review draft", () => {
  for (const raw of [null, "{", "null", "[]", JSON.stringify({ ...draft, version: 2 }), JSON.stringify({ ...draft, vote: "99" }), JSON.stringify({ ...draft, comments: [{ ...draft.comments[0], range: { start: -1, end: 2 } }] }), JSON.stringify({ ...draft, replies: [{}] })]) {
    assert.equal(parseReviewDraft(raw), null);
  }
});

test("unfinished scope, inline and reply buffers retain their exact editor state", () => {
  const buffers = [
    { id: "scope", value: { kind: "scope", path: "/PATCHSET_LEVEL", key: null, message: "Still writing", resolved: false } },
    { id: "draft-1", value: { kind: "inline", ...draft.comments[0] } },
    { id: "reply:gerrit:thread-1", value: { kind: "reply", ...draft.replies[0] } },
  ];
  assert.deepEqual(parseReviewEditorBuffers(JSON.stringify(buffers)), buffers);
  assert.deepEqual(parseReviewEditorBuffers(JSON.stringify([...buffers, { id: "invalid", value: { kind: "inline", range: {} } } ])), buffers);
  assert.deepEqual(parseReviewEditorBuffers("{"), []);
});

test("drafts are isolated by host, project, change, target revision and comparison base", () => {
  const key = reviewDraftKey("review.example.com", "p", 123, "rev", 1);
  assert.notEqual(key, reviewDraftKey("review.example.com", "p", 123, "rev"));
  assert.notEqual(key, reviewDraftKey("review.example.com", "p", 123, "rev", 2));
  assert.notEqual(key, reviewDraftKey("other.example.com", "p", 123, "rev", 1));
  assert.notEqual(key, reviewDraftKey("review.example.com", "q", 123, "rev", 1));
  assert.notEqual(key, reviewDraftKey("review.example.com", "p", 124, "rev", 1));
  assert.notEqual(key, reviewDraftKey("review.example.com", "p", 123, "other", 1));
});
