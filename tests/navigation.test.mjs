import "./helpers/components.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
const { UrlForm } = await import("../components/app-chrome.tsx");
const { Dashboard } = await import("../components/dashboard.tsx");
const { GerritDiffApp } = await import("../components/gerritdiff-app.tsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const events = new EventTarget();
globalThis.window = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  scrollY: 0,
};
const profile = { server: "https://example.com/", username: "me" };
const dashboardUrl = "/dashboard?server=https%3A%2F%2Fexample.com%2F&user=me&scope=all&state=all";
function navigate(href) {
  const url = new URL(href, "https://gerritdiff.test");
  navigation.pathname = url.pathname;
  navigation.params = url.searchParams;
}
const navigation = globalThis.testNavigation = {
  params: new URLSearchParams(), pathname: "/",
  router: { push: navigate, replace: navigate },
};
const change = (n, owner) => ({
  id: String(n), sourceUrl: `https://example.com/c/p/+/${n}`, changeNumber: n, subject: `Change ${n}`, project: "p", branch: "main", status: "Active", updated: new Date().toISOString(),
  owner: { name: owner, email: `${owner.toLowerCase()}@example.com` }, scopes: ["mine"], group: "action", evidence: "explicit", facts: [], diagnosis: "Needs review", ci: "unknown", requirements: [],
});
const dashboardData = {
  server: profile.server, fetchedAt: new Date().toISOString(), identity: { username: "me", mode: "username" },
  changes: [change(1, "Alice"), change(2, "Bob")], warnings: [], mergedLoaded: false,
};
const viewerData = (n) => ({
  sourceUrl: `https://example.com/c/p/+/100/${n}`, revision: `ps${n}`, revisionNumber: n,
  changeNumber: 100, host: "example.com", sshHost: "example.com", owner: { name: "Alice" },
});
async function mount(component, props) {
  let renderer;
  await act(async () => { renderer = create(createElement(component, props)); });
  return renderer;
}
async function update(renderer, component, props) {
  await act(async () => { renderer.update(createElement(component, props)); });
}
async function unmount(renderer) { await act(async () => renderer.unmount()); }

test("URL input follows a changed source URL but retains edits on ordinary re-renders", async () => {
  const renderer = await mount(UrlForm, { initial: "PS2" });
  await act(async () => renderer.root.findByType("input").props.onChange({ target: { value: "my edit" } }));
  await update(renderer, UrlForm, { initial: "PS2", compact: true });
  assert.equal(renderer.root.findByType("input").props.value, "my edit");
  await update(renderer, UrlForm, { initial: "PS1" });
  assert.equal(renderer.root.findByType("input").props.value, "PS1");
  await unmount(renderer);
});

test("same-mounted dashboard owner navigation and Back/Forward retain URL filters", async (t) => {
  navigate(dashboardUrl);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return Response.json(dashboardData);
  });
  const renderer = await mount(Dashboard, { profile, onForget() {} });
  const owners = () => renderer.root.findAllByProps({ className: "dashboard-change-owner" });
  assert.equal(owners().length, 2);
  const aliceLink = owners()[0].findByType("a");
  await act(async () => aliceLink.props.onClick({ button: 0, preventDefault() {} }));
  const aliceUrl = `${navigation.pathname}?${navigation.params}`;
  await update(renderer, Dashboard, { profile, onForget() {} });
  assert.equal(navigation.params.get("owner"), "alice@example.com");
  assert.equal(owners().length, 1);
  assert.ok(requests.some((url) => url.includes("owner=alice%40example.com")));

  navigate(dashboardUrl);
  await update(renderer, Dashboard, { profile, onForget() {} });
  assert.equal(navigation.params.get("owner"), null);
  assert.equal(owners().length, 2);
  navigate(aliceUrl);
  await update(renderer, Dashboard, { profile, onForget() {} });
  assert.equal(owners().length, 1);

  // A control change preserves the navigated owner and changes only its own filter.
  await act(async () => renderer.root.findByProps({ "aria-label": "Sort changes" }).props.onChange({ target: { value: "oldest" } }));
  await update(renderer, Dashboard, { profile, onForget() {} });
  assert.equal(navigation.params.get("owner"), "alice@example.com");
  assert.equal(navigation.params.get("sort"), "oldest");
  await unmount(renderer);
});

test("loader recovers from a failed comparison on navigation and ignores aborted results", async (t) => {
  const target = viewerData(2).sourceUrl;
  const validUrl = `/?url=${encodeURIComponent(target)}`;
  navigate(validUrl);
  let pending;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("base=1")) return Response.json({ error: "Failed comparison" }, { status: 400 });
    if (url.includes("base=3")) return new Promise((resolve) => { pending = resolve; });
    return Response.json(viewerData(2));
  });
  const renderer = await mount(GerritDiffApp);
  assert.equal(renderer.root.findByProps({ "data-revision": 2 }).type, "div");
  navigate(`${validUrl}&base=1`);
  await update(renderer, GerritDiffApp);
  assert.equal(renderer.root.findAllByProps({ className: "state-card error-card" }).length, 1);
  navigate(validUrl);
  await update(renderer, GerritDiffApp);
  assert.equal(renderer.root.findAllByProps({ className: "state-card error-card" }).length, 0);
  assert.equal(renderer.root.findByProps({ "data-revision": 2 }).type, "div");

  navigate(`${validUrl}&base=3`);
  await update(renderer, GerritDiffApp);
  navigate(validUrl);
  await update(renderer, GerritDiffApp);
  await act(async () => pending(Response.json(viewerData(3))));
  assert.equal(renderer.root.findAllByProps({ "data-revision": 3 }).length, 0);
  assert.equal(renderer.root.findByProps({ "data-revision": 2 }).type, "div");
  await unmount(renderer);
});
