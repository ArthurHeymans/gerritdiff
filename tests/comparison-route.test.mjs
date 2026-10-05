import "./helpers/components.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockGerritFetch, ps2, source } from "./helpers/gerrit-fixture.mjs";
const { NextRequest } = await import("next/server.js");
const { GET } = await import("../app/api/change/route.ts");

test("comparison URLs load base and target snapshots through the change API", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return mockGerritFetch(url);
  });
  const load = (url, base) => GET(new NextRequest(`https://gerritdiff.test/api/change?${new URLSearchParams({ url, ...(base === undefined ? {} : { base }) })}`));
  const response = await load(`${source}/1..2`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.revisionNumber, 2);
  assert.equal(data.baseRevisionNumber, 1);
  assert.equal(data.revision, ps2);
  assert.match(data.comparisonFiles[0].baseContent, /ps1 line 3/);
  assert.match(data.comparisonFiles[0].targetContent, /ps2 line 3/);
  assert.ok(requests.some((url) => url.includes(`/revisions/${ps2}/files?base=1`)));
  assert.equal(requests.some((url) => url.endsWith("/patch")), false);

  const plain = await (await load(`${source}/2`)).json();
  assert.equal(plain.baseRevisionNumber, undefined);
  assert.ok(plain.patch);
  assert.equal((await load(`${source}/1..2`, "2")).status, 400);
  assert.equal((await load(`${source}/3..2`)).status, 400);
  assert.equal((await load(`${source}/1..2`, "")).status, 400);
});
