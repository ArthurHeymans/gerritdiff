import assert from "node:assert/strict";
import { test } from "node:test";
import { patchsetUrl } from "../lib/gerrit-url.ts";
import { parseGerritUrl, resolveChange } from "../lib/gerrit-server.ts";

const sourceUrl = "https://gerrit.openbmc.org/c/openbmc/phosphor-host-ipmid/+/95217";

test("snapshot URLs are pinned to the displayed patchset", () => {
  for (const [input, expected] of [
    [sourceUrl, `${sourceUrl}/2`],
    [`${sourceUrl}/1/dbus-sdr/fruwrite.cpp`, `${sourceUrl}/2`],
    [`${sourceUrl}/1..2`, `${sourceUrl}/2`],
    [`${sourceUrl}/1..2/dbus-sdr/fruwrite.cpp`, `${sourceUrl}/2`],
    ["https://example.com/gerrit/#/c/95217/1..2/file.cpp", "https://example.com/gerrit/#/c/95217/2"],
    ["https://example.com/gerrit/c/project/+/95217", "https://example.com/gerrit/c/project/+/95217/2"],
    ["https://example.com/gerrit/#/c/95217/1/file.cpp", "https://example.com/gerrit/#/c/95217/2"],
    ["https://example.com/c/95217", "https://example.com/c/95217/2"],
  ]) {
    const pinned = patchsetUrl(input, 95217, 2);
    assert.equal(pinned, expected);
    assert.equal(parseGerritUrl(pinned).revision, "2");
  }
});

test("Gerrit comparison URLs select the right-hand target and preserve the left-hand base", () => {
  for (const url of [
    `${sourceUrl}/1..2`,
    `${sourceUrl}/1..2/file.cpp`,
    "https://example.com/#/c/95217/1..2",
    "https://example.com/c/95217/1..2/file.cpp",
  ]) {
    assert.equal(parseGerritUrl(url).revision, "2");
    assert.equal(parseGerritUrl(url).baseRevision, "1");
  }
  assert.equal(parseGerritUrl(`${sourceUrl}/2`).baseRevision, undefined);
});

test("a pinned snapshot does not follow a newer current patchset", async (t) => {
  // A literal public IP avoids DNS/network dependencies; all HTTP is mocked.
  const source = "https://8.8.8.8/c/project/+/95217";
  const ps1 = "1".repeat(40);
  const ps2 = "2".repeat(40);
  let current = ps1;
  t.mock.method(globalThis, "fetch", async () => new Response(`)]}'\n${JSON.stringify({
    current_revision: current,
    revisions: { [ps1]: { _number: 1 }, [ps2]: { _number: 2 } },
  })}`));

  const displayed = await resolveChange(source);
  current = ps2;
  const snapshot = await resolveChange(patchsetUrl(source, 95217, displayed.revisionNumber));
  assert.equal(snapshot.revision, displayed.revision);
  assert.equal(snapshot.revision, ps1);
  assert.equal((await resolveChange(source)).revision, ps2);
  assert.equal((await resolveChange(`${source}/2`)).revision, ps2);
  const comparison = await resolveChange(`${source}/1..2`);
  assert.equal(comparison.revision, ps2);
  assert.equal(comparison.parsed.baseRevision, "1");
  await assert.rejects(resolveChange(`${source}/3`), /Patchset not found/);
});
