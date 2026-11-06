import assert from "node:assert/strict";
import { test } from "node:test";
import { sshUsernameError } from "../lib/ssh-user.ts";

test("SSH export rejects missing, placeholder and malformed usernames", () => {
  for (const value of ["", "   ", "YOUR_USERNAME", " your_username ", "Sam Reviewer", "sam@example.com", "-sam", "sam\nreviewer", "sam/reviewer"]) {
    assert.ok(sshUsernameError(value), JSON.stringify(value));
  }
});

test("SSH export accepts Gerrit login names and trims incidental whitespace", () => {
  for (const value of ["sam", "sam-reviewer", "sam.reviewer", "sam_reviewer", "1234", " sam-reviewer "]) {
    assert.equal(sshUsernameError(value), undefined);
  }
});
