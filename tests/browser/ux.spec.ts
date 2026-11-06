import { test, expect, type Page } from "@playwright/test";
import type { ChangeData } from "../../lib/types";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? []).toEqual([]); });

const sourceUrl = "https://review.example.com/c/firmware/+/123/2";
const subject = "Improve firmware initialization and preserve diagnostic context across dependent changes";
const change: ChangeData = {
  host: "review.example.com", sshHost: "review.example.com", sourceUrl,
  changeNumber: 123, subject, commitMessage: `${subject}\n\nKeep diagnostics available during initialization.`,
  commentLinks: [], commitMessageLineOffset: 7, project: "platform/firmware", branch: "main", status: "Active",
  owner: { name: "Alex Morgan", email: "alex@example.com" },
  reviewers: [{ name: "Sam Reviewer", codeReview: 2 }],
  checks: [{ name: "Build & test", result: "SUCCESS", url: "https://ci.example.com/123" }],
  revision: "b".repeat(40), revisionNumber: 2,
  revisions: [{ revision: "a".repeat(40), number: 1 }, { revision: "b".repeat(40), number: 2 }],
  updated: "2026-10-01T12:00:00Z", insertions: 1, deletions: 1,
  patch: "diff --git a/src/init.c b/src/init.c\n--- a/src/init.c\n+++ b/src/init.c\n@@ -1,3 +1,3 @@\n void init(void) {\n-  boot();\n+  boot_with_diagnostics();\n }\n",
  comments: [{ id: "thread-1", path: "src/init.c", side: "REVISION", line: 2, patchSet: 2, message: "Can we retain the previous error context?", author: { name: "Sam Reviewer" }, updated: "2026-10-01T12:00:00Z", unresolved: true }],
  relationChain: [],
};

async function mockChange(page: Page, withRelations = false, comments = change.comments) {
  await page.route("**/api/change?**", (route) => {
    const request = new URL(route.request().url());
    const patchset = Number(new URL(request.searchParams.get("url")!).pathname.split("/").at(-1));
    const revisionNumber = patchset === 1 ? 1 : 2;
    return route.fulfill({ json: { ...change, comments, relationChain: withRelations ? [{ project: change.project, changeNumber: 123, subject, commit: change.revision, isCurrent: true }, { project: change.project, changeNumber: 124, subject: "Dependent change", commit: "c".repeat(40), isCurrent: false }] : [], revisionNumber, revision: (revisionNumber === 1 ? "a" : "b").repeat(40), baseRevisionNumber: request.searchParams.has("base") ? Number(request.searchParams.get("base")) : undefined } });
  });
  await page.route("**/api/repository/tree?**", (route) => route.fulfill({ json: { available: false, entries: [], error: "No Gitiles link advertised. Open a known path below." }, status: 501 }));
  await page.route("**/api/repository/content?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const content = query.get("path") === "src/init.c"
      ? `void init(void) {\n  ${query.has("parent") ? "boot" : "boot_with_diagnostics"}();\n}\n`
      : "unchanged_repository_line();\nsecond_repository_line();\n";
    return route.fulfill({ json: { exists: true, content } });
  });
}
const longPatch = `diff --git a/src/init.c b/src/init.c\n--- a/src/init.c\n+++ b/src/init.c\n@@ -1,180 +1,180 @@\n${Array.from({ length: 180 }, (_, index) => index === 1 ? "-  boot();\n+  boot_with_diagnostics();" : ` line ${index + 1}`).join("\n")}\n`;
async function mockLongChange(page: Page, overrides: Partial<typeof change> = {}) {
  await mockChange(page);
  await page.route("**/api/change?**", (route) => route.fulfill({ json: { ...change, patch: longPatch, comments: [], ...overrides } }));
}
async function showChangeOverview(page: Page) {
  await expect(page.locator(".review-layout")).toHaveAttribute("aria-busy", "false");
  const back = page.getByRole("button", { name: "Back to change details", exact: true });
  if (await page.locator(".pierre-code-view").getAttribute("data-review-stuck") === "true") {
    await expect(back).toBeVisible();
    await back.click();
  }
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toBeVisible();
}
async function openPatchsetComments(page: Page) {
  await showChangeOverview(page);
  await page.getByRole("button", { name: "Patchset comment", exact: true }).click();
}
async function choosePatchset(page: Page, patchset: string) {
  await showChangeOverview(page);
  await page.getByRole("combobox", { name: "Target patchset" }).selectOption(patchset);
  await expect(page.locator(".review-layout")).toHaveAttribute("data-review-revision", patchset);
  await expect(page.locator(".review-layout")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("boot_with_diagnostics();", { exact: false })).toBeVisible();
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("rendered review controls use readable sizes, including touch inputs", async ({ page, browser }) => {
  await mockChange(page);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await expect(page.getByText("boot_with_diagnostics();", { exact: false })).toBeVisible();
  await page.keyboard.press("Control+f");
  const sizes = await page.locator(".patchset-picker select, .sidebar-diff-stat, .view-settings > summary, .code-search input").evaluateAll((elements) => elements.map((element) => ({ selector: element.className || element.tagName, size: parseFloat(getComputedStyle(element).fontSize) })));
  for (const control of sizes) expect(control.size).toBeGreaterThanOrEqual(12);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const touchPage = await context.newPage();
    await mockChange(touchPage);
    await touchPage.goto(`${new URL(page.url()).origin}/?url=${encodeURIComponent(sourceUrl)}`);
    await touchPage.getByRole("button", { name: "Export review", exact: true }).click();
    const inputSizes = await touchPage.locator(".publish-review-fields input, .publish-review-fields textarea, .publish-review-fields select").evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
    for (const size of inputSizes) expect(size).toBeGreaterThanOrEqual(16);
  } finally { await context.close(); }
});

for (const width of [320, 390, 900, 1440]) {
  test(`${width}px overview scrolls into one sticky title without jumping or duplicate controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const longSubject = `${subject}: ${"keep detailed diagnostics available during every initialization stage ".repeat(3)}`.trim();
    await mockLongChange(page, { subject: longSubject, project: `platform/${"very-long-nested-project/".repeat(12)}firmware` });
    await page.addInitScript(() => localStorage.setItem("gerritdiff:reviewers-expanded", "false"));
    await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
    await showChangeOverview(page);
    const code = page.locator(".pierre-code-view");
    const title = page.getByRole("heading", { name: longSubject, exact: true });
    await expect(title).toBeVisible();
    await expect(page.getByRole("button", { name: "Change details", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: longSubject, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export review", exact: true })).toHaveCount(1);
    expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.locator(".change-header").evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && getComputedStyle(element).overflowY === "visible")).toBe(true);
    const reviewContext = page.getByRole("region", { name: "Review context", exact: true });
    await expect(reviewContext.locator("summary")).toHaveCount(0);
    await expect(reviewContext.getByText("Sam Reviewer", { exact: true })).toBeVisible();
    await expect(reviewContext.getByText("CR +2", { exact: true })).toBeVisible();
    await expect(reviewContext.getByRole("link", { name: /Build & test/ })).toBeVisible();
    expect(await reviewContext.locator(".reviewers-list").evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    expect(await code.evaluate(async (element) => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return element.scrollTop; })).toBe(0);
    const target = Math.ceil(await page.locator(".review-overview").evaluate((element) => element.getBoundingClientRect().height)) + 300;
    await code.evaluate((element, position) => { element.scrollTop = position; }, target);
    await expect(code).toHaveAttribute("data-review-stuck", "true");
    expect(await code.evaluate((element) => element.scrollTop)).toBe(target);
    await expect(title).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Export review", exact: true })).toHaveCount(1);
    const sticky = await page.locator(".review-sticky-controls").boundingBox();
    const root = await code.boundingBox();
    expect(sticky!.y).toBe(root!.y);
    expect(sticky!.height).toBeLessThan(width < 800 ? 180 : 120);
    expect((await page.getByRole("button", { name: "Load full file", exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(sticky!.y + sticky!.height - 1);
    await noPageOverflow(page);
    const back = page.getByRole("button", { name: "Back to change details", exact: true });
    await back.focus();
    await page.keyboard.press("Enter");
    await expect(code).toHaveAttribute("data-review-stuck", "false");
    await expect(title).toBeFocused();
    expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
    await code.evaluate((element, position) => { element.scrollTop = position; }, target);
    await expect(code).toHaveAttribute("data-review-stuck", "true");
    await code.evaluate((element) => { element.scrollTop = 0; });
    await expect(title).toBeVisible();
    await page.reload();
    await expect(code).toHaveAttribute("data-review-stuck", "false");
    expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
  });
}

for (const width of [390, 1440]) {
  test(`${width}px sticky controls preserve file navigation, settings, search and comparison`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockLongChange(page);
    await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
    await showChangeOverview(page);
    if (width < 800) await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("treeitem", { name: "init.c", exact: true }).click();
    const code = page.locator(".review-code-surface > .pierre-code-view");
    await expect(code).toHaveAttribute("data-review-stuck", "true");
    const boot = page.getByText("boot_with_diagnostics();", { exact: false });
    await expect(boot).toBeInViewport();
    const bar = await page.locator(".review-sticky-controls").boundingBox();
    expect((await boot.boundingBox())!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    const view = page.locator(".review-sticky-controls .view-settings > summary");
    await view.click();
    await page.getByRole("checkbox", { name: "Show whitespace", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "Show whitespace", exact: true })).toBeChecked();
    await view.click();
    await page.keyboard.press("Control+f");
    await page.locator(".code-search input").fill("line 140");
    await page.locator(".code-search input").press("Enter");
    await expect(page.getByText("line 140", { exact: true }).first()).toBeInViewport();
    await page.getByRole("button", { name: "Close search", exact: true }).click();
    await page.getByRole("button", { name: "Export review", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Export review to Gerrit" })).toBeVisible();
    await page.keyboard.press("Escape");
    await showChangeOverview(page);
    await page.getByRole("button", { name: "Compare files", exact: true }).click();
    await expect(page.locator(".moved-code-compare")).toBeVisible();
    await expect(code).toHaveAttribute("data-review-stuck", "true");
    const sticky = await page.locator(".review-sticky-controls").boundingBox();
    expect((await page.locator(".moved-code-compare").boundingBox())!.y).toBeGreaterThanOrEqual(sticky!.y + sticky!.height - 1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Compare files", exact: true })).toBeFocused();
    await expect(code).toHaveAttribute("data-review-stuck", "false");
    expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
    await noPageOverflow(page);
  });
}

test("long reviewer lists use the overview scroll surface, not a nested scroller", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLongChange(page, { reviewers: Array.from({ length: 40 }, (_, index) => ({ name: `Reviewer ${index + 1}`, codeReview: 1 })) });
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await showChangeOverview(page);
  const list = page.locator(".reviewers-list");
  const sizes = await list.evaluate((element) => ({ overflow: getComputedStyle(element).overflowY, height: element.clientHeight, content: element.scrollHeight }));
  expect(sizes.overflow).toBe("visible");
  expect(sizes.content).toBeLessThanOrEqual(sizes.height + 1);
  const lastReviewer = page.getByText("Reviewer 40", { exact: true });
  await lastReviewer.scrollIntoViewIfNeeded();
  await expect(lastReviewer).toBeInViewport();
  expect(await page.locator(".pierre-code-view").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await noPageOverflow(page);
});

test("scroll-driven header changes preserve active comment text", async ({ page }) => {
  await mockLongChange(page);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await openPatchsetComments(page);
  await page.getByRole("button", { name: "Add patchset comment" }).click();
  const editor = page.getByPlaceholder("Comment on the whole patchset…");
  await editor.fill("Keep this editor while scrolling the review.");
  const code = page.locator(".pierre-code-view");
  await code.evaluate((element) => { element.scrollTop = 900; });
  await expect(code).toHaveAttribute("data-review-stuck", "true");
  await expect(editor).toHaveValue("Keep this editor while scrolling the review.");
  await showChangeOverview(page);
  await expect(editor).toHaveValue("Keep this editor while scrolling the review.");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.getByText("Keep this editor while scrolling the review.", { exact: true })).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`${width}px sticky header retains the comparison and failing checks`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockLongChange(page, { baseRevisionNumber: 1, checks: [{ name: "Firmware build failed", result: "FAILURE", url: "https://ci.example.com/failed" }] });
    await page.goto(`/?url=${encodeURIComponent(sourceUrl)}&base=1`);
    await showChangeOverview(page);
    const code = page.locator(".pierre-code-view");
    await code.evaluate((element) => { element.scrollTop = 900; });
    await expect(code).toHaveAttribute("data-review-stuck", "true");
    await expect(page.locator(".sticky-patchset")).toHaveText("PS 1 → 2");
    await page.getByRole("button", { name: "Checks need attention", exact: true }).click();
    await expect(code).toHaveAttribute("data-review-stuck", "false");
    await expect(page.getByRole("link", { name: /Firmware build failed/ })).toBeVisible();
    await noPageOverflow(page);
  });
}

for (const width of [390, 1440]) {
  test(`${width}px export validates the SSH username and keeps Copy in reach`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await mockChange(page);
    await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
    await page.getByRole("button", { name: "Export review", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export review to Gerrit" });
    const copy = dialog.getByRole("button", { name: "Copy command", exact: true });
    const username = dialog.getByRole("textbox", { name: "SSH username", exact: true });
    await expect(copy).toBeDisabled();
    await expect(copy).toBeInViewport();
    await username.fill("YOUR_USERNAME");
    await expect(copy).toBeDisabled();
    await expect(dialog.getByText("Replace the placeholder with your Gerrit SSH username.", { exact: true }).first()).toBeVisible();
    await username.fill("Sam Reviewer");
    await expect(copy).toBeDisabled();
    await username.fill("sam-reviewer");
    await expect(copy).toBeEnabled();
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (command: string) => { (window as unknown as { copiedReviewCommand: string }).copiedReviewCommand = command; } }));
    await dialog.locator(".export-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(copy).toBeInViewport();
    await dialog.getByText("Command details & draft recovery", { exact: true }).click();
    await expect(dialog.getByText(/The command sends Gerrit a/)).toBeVisible();
    await copy.click();
    await expect(dialog.getByRole("status")).toContainText("Command copied — not published");
    expect(await page.evaluate(() => (window as unknown as { copiedReviewCommand: string }).copiedReviewCommand)).toContain("sam-reviewer@review.example.com");
    await noPageOverflow(page);
  });
}

for (const width of [1440, 900, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`${width}px ${theme}: readable, navigable review and recoverable drafts`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((theme) => localStorage.setItem("gerritdiff-theme", theme), theme);
      await mockChange(page);
      await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
      await expect(page.getByRole("heading", { name: subject })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByText("boot_with_diagnostics();", { exact: false })).toBeVisible();
      await noPageOverflow(page);
      expect(await page.locator(".pierre-code-view").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(200);
      expect(await page.locator(".change-meta").evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
      await page.screenshot({ path: testInfo.outputPath("review.png") });

      if (width <= 1250) {
        await page.getByRole("button", { name: "Browse", exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "Files & discussions" });
        await expect(drawer).toBeVisible();
        await drawer.getByRole("button", { name: /Discussion/ }).click();
        await drawer.getByRole("button", { name: /Can we retain/ }).click();
        await expect(drawer).not.toBeVisible();
        await expect(page.getByRole(width <= 800 ? "dialog" : "complementary", { name: "Selected discussion" })).toBeVisible();
        await page.getByRole("button", { name: "Close side panel" }).click();
      }
      if (width <= 800) {
        await page.getByRole("button", { name: "Workspace actions" }).click();
        const actions = page.getByRole("dialog", { name: "Workspace actions" });
        await expect(actions.getByRole("button", { name: "Toggle color theme" })).toBeVisible();
        await expect(actions.getByRole("link", { name: "Gerrit" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: "Workspace actions" })).toBeFocused();
      }

      await openPatchsetComments(page);
      await page.getByRole("button", { name: "Add patchset comment" }).click();
      await page.getByPlaceholder("Comment on the whole patchset…").fill("Retain this draft across reloads.");
      await page.getByRole("button", { name: "Save comment", exact: true }).click();
      await page.getByRole("button", { name: "Close side panel" }).click();
      await page.getByRole("button", { name: "Export review", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Export review to Gerrit" });
      await expect(dialog.getByText("Nothing has been published.")).toBeVisible();
      await page.keyboard.press("Control+f");
      await expect(page.getByRole("textbox", { name: "Find in diff" })).not.toBeVisible();
      await dialog.getByLabel("Cover message", { exact: true }).fill("Overall looks good.");
      await dialog.getByRole("combobox", { name: "Code-Review", exact: true }).selectOption("1");
      await page.screenshot({ path: testInfo.outputPath("export.png") });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Export review", exact: true })).toBeFocused();
      await page.reload();
      await expect(page.getByText("Drafts saved in this tab", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Export review", exact: true }).click();
      await expect(dialog.getByLabel("Cover message", { exact: true })).toHaveValue("Overall looks good.");
      await expect(dialog.getByRole("combobox", { name: "Code-Review", exact: true })).toHaveValue("1");
      await expect(dialog.getByText("Retain this draft across reloads.", { exact: true })).toBeVisible();
      await dialog.getByRole("textbox", { name: "SSH username", exact: true }).fill("sam-reviewer");
      await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async () => { throw new Error("denied"); } }));
      await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
      await expect(dialog.getByRole("status")).toContainText("Clipboard unavailable");
      await noPageOverflow(page);
    });
  }
}

test("client-side patchset navigation protects active comment text", async ({ page }) => {
  await mockChange(page);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await openPatchsetComments(page);
  await page.getByRole("button", { name: "Add patchset comment" }).click();
  await page.getByPlaceholder("Comment on the whole patchset…").fill("Do not lose my active writing.");
  let warning = "";
  page.once("dialog", async (dialog) => { warning = dialog.message(); await dialog.dismiss(); });
  await page.getByRole("combobox", { name: "Target patchset" }).selectOption("1");
  expect(warning).toContain("unfinished comment text");
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("2");
  await expect(page.getByPlaceholder("Comment on the whole patchset…")).toHaveValue("Do not lose my active writing.");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await choosePatchset(page, "1");
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await choosePatchset(page, "2");
  await expect(page.locator(".review-layout")).toHaveAttribute("data-review-revision", "2");
  await page.getByRole("button", { name: "Export review", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Do not lose my active writing.", { exact: true })).toBeVisible();
});

test("Back and Forward recover unfinished scope comments instead of silently losing text", async ({ page }) => {
  await mockChange(page);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await choosePatchset(page, "1");
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await choosePatchset(page, "2");
  await openPatchsetComments(page);
  await page.getByRole("button", { name: "Add patchset comment" }).click();
  await page.getByPlaceholder("Comment on the whole patchset…").fill("Unfinished history text must return.");
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await page.goForward();
  await expect(page.getByPlaceholder("Comment on the whole patchset…")).toHaveValue("Unfinished history text must return.");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await page.getByRole("button", { name: "Close side panel" }).click();
  await page.getByRole("button", { name: "Export review", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Unfinished history text must return.", { exact: true })).toBeVisible();
});

test("relation chain and another scope editor cannot silently replace active writing", async ({ page }) => {
  await mockChange(page, true);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await showChangeOverview(page);
  await page.getByRole("button", { name: /Sam Reviewer 1 comment/ }).click();
  const discussion = page.getByRole("complementary", { name: "Selected discussion" });
  await discussion.getByRole("button", { name: "Reply", exact: true }).click();
  await discussion.getByPlaceholder("Write a reply…").fill("Keep my unfinished reply.");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /Relation chain/ }).click();
  await expect(discussion.getByPlaceholder("Write a reply…")).toHaveValue("Keep my unfinished reply.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Relation chain/ }).click();
  await expect(page.getByRole("complementary", { name: "Relation chain" })).toBeVisible();
  await page.getByRole("button", { name: /Sam Reviewer 1 comment/ }).click();
  await expect(discussion.getByPlaceholder("Write a reply…")).toHaveValue("Keep my unfinished reply.");
  await discussion.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close side panel" }).click();
  await openPatchsetComments(page);
  const scope = page.getByRole("complementary", { name: "Patchset comments" });
  for (const text of ["First saved comment", "Second saved comment"]) {
    await page.getByRole("button", { name: "Add patchset comment" }).click();
    await page.getByPlaceholder("Comment on the whole patchset…").fill(text);
    await page.getByRole("button", { name: "Save comment", exact: true }).click();
  }
  await scope.getByRole("button", { name: "Edit", exact: true }).nth(0).click();
  await page.getByPlaceholder("Comment on the whole patchset…").fill("First unfinished edit");
  page.once("dialog", (dialog) => dialog.dismiss());
  await scope.getByRole("button", { name: "Edit", exact: true }).nth(1).click();
  await expect(page.getByPlaceholder("Comment on the whole patchset…")).toHaveValue("First unfinished edit");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(scope.getByText("First unfinished edit", { exact: true })).toBeVisible();
});

test("unfinished replies never cross discussion recipients or export anchors", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockChange(page, false, [...change.comments, { ...change.comments[0], id: "thread-2", line: 3, message: "A separate question for Taylor.", author: { name: "Taylor Reviewer" } }]);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  const panel = page.getByRole("complementary", { name: "Selected discussion" });
  const buffers = () => page.evaluate(() => Object.keys(sessionStorage)
    .filter((key) => key.endsWith(":editors"))
    .flatMap((key) => JSON.parse(sessionStorage.getItem(key)!) as { value: { kind: string; key: string; message: string } }[])
    .filter((entry) => entry.value.kind === "reply").map((entry) => entry.value));

  await page.getByRole("button", { name: /Sam Reviewer 1 comment/ }).click();
  await panel.getByRole("button", { name: "Reply", exact: true }).click();
  await panel.getByPlaceholder("Write a reply…").fill("FOR SAM ONLY");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Taylor Reviewer 1 comment/ }).click();
  await expect(panel.getByPlaceholder("Write a reply…")).not.toBeVisible();
  const held = await buffers();
  expect(held).toHaveLength(1);
  expect(held[0].key).toContain("thread-1");
  expect(held[0].message).toBe("FOR SAM ONLY");

  await panel.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(panel.getByPlaceholder("Write a reply…")).toHaveValue("");
  await panel.getByPlaceholder("Write a reply…").fill("FOR TAYLOR ONLY");
  await panel.getByRole("button", { name: "Save reply", exact: true }).click();
  await page.getByRole("button", { name: /Sam Reviewer 1 comment/ }).click();
  await expect(panel.getByPlaceholder("Write a reply…")).toHaveValue("FOR SAM ONLY");
  await panel.getByRole("button", { name: "Save reply", exact: true }).click();
  expect(await buffers()).toEqual([]);
  await page.getByRole("button", { name: "Close side panel" }).click();
  await page.getByRole("button", { name: "Export review", exact: true }).click();
  const command = await page.getByLabel("Review SSH command").innerText();
  const input = JSON.parse(command.match(/<<'GERRIT_REVIEW'\n([\s\S]*?)\nGERRIT_REVIEW(?:\n|$)/)![1]);
  expect(input.comments["src/init.c"]).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: "FOR SAM ONLY", in_reply_to: "thread-1", line: 2 }),
    expect.objectContaining({ message: "FOR TAYLOR ONLY", in_reply_to: "thread-2", line: 3 }),
  ]));
  expect(input.comments["src/init.c"]).toHaveLength(2);
});

test("Back and Forward recover unfinished inline comments and discussion replies", async ({ page }) => {
  await mockChange(page);
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await choosePatchset(page, "1");
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await choosePatchset(page, "2");
  const file = page.locator("diffs-container").filter({ has: page.locator('[data-title]').filter({ hasText: "src/init.c" }) });
  await file.locator('[data-column-number="1"]').first().hover();
  await file.locator('[data-utility-button]').click();
  await file.getByPlaceholder("Add a comment…").fill("Unfinished inline text.");
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await page.goForward();
  await expect(file.getByPlaceholder("Add a comment…")).toHaveValue("Unfinished inline text.");
  await file.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /Sam Reviewer 1 comment/ }).click();
  const discussion = page.getByRole("complementary", { name: "Selected discussion" });
  await discussion.getByRole("button", { name: "Reply", exact: true }).click();
  await discussion.getByPlaceholder("Write a reply…").fill("Unfinished history reply.");
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Target patchset" })).toHaveValue("1");
  await page.goForward();
  await expect(discussion.getByPlaceholder("Write a reply…")).toHaveValue("Unfinished history reply.");
});

for (const width of [320, 390]) {
  test(`${width}px file identity and keyboard focus survive discussion handoff`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockChange(page);
    await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
    const filename = page.locator('[data-title]').filter({ hasText: "src/init.c" });
    await expect(filename).toBeVisible();
    expect(await filename.evaluate((element) => element.clientWidth >= element.scrollWidth && element.clientWidth > 45)).toBe(true);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Files & discussions" });
    await drawer.getByRole("button", { name: /Discussion/ }).click();
    await drawer.getByRole("button", { name: /Can we retain/ }).click();
    const panel = page.getByRole("dialog", { name: "Selected discussion" });
    await expect(panel.getByRole("button", { name: "Close side panel" })).toBeFocused();
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("Tab");
      expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Browse", exact: true })).toBeFocused();
    await noPageOverflow(page);
  });
}

test("known-path navigation closes the drawer and restores editable repository drafts", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChange(page);
  const openFile = async () => {
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Files & discussions" });
    await drawer.getByRole("button", { name: "Repository", exact: true }).click();
    await drawer.getByRole("textbox", { name: "Repository file path" }).fill("src/unchanged.c");
    await drawer.getByRole("button", { name: "Open", exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByText("unchanged_repository_line();", { exact: true })).toBeVisible();
  };
  await page.goto(`/?url=${encodeURIComponent(sourceUrl)}`);
  await openFile();
  // Next's development indicator covers the first gutter button at this viewport.
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  const file = page.locator("diffs-container").filter({ has: page.getByText("unchanged_repository_line();", { exact: true }) });
  await file.locator('[data-column-number="1"]').hover();
  await file.locator('[data-utility-button]').click();
  await file.getByPlaceholder("Add a comment…").fill("Repository draft should remain editable.");
  await file.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(file.getByText("Repository draft should remain editable.", { exact: true })).toBeVisible();
  await page.reload();
  await openFile();
  await expect(file.getByText("Repository draft should remain editable.", { exact: true })).toBeVisible();
  await file.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(file.getByPlaceholder("Add a comment…")).toHaveValue("Repository draft should remain editable.");
  await file.getByPlaceholder("Add a comment…").fill("Temporary edit that will be cancelled.");
  await file.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(file.getByText("Repository draft should remain editable.", { exact: true })).toBeVisible();
  await file.getByRole("button", { name: "Edit", exact: true }).click();
  await file.getByPlaceholder("Add a comment…").fill("Edited after recovery.");
  await file.getByRole("button", { name: "Save comment", exact: true }).click();
  await file.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(file.getByText("Edited after recovery.", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Export review", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Edited after recovery.", { exact: true })).not.toBeVisible();
});

test("landing and dashboard retain mobile controls, filtering has an escape route", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Read Gerrit changes, faster." })).toBeVisible();
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("landing.png"), fullPage: true });
  await page.route("**/api/dashboard?**", (route) => route.fulfill({ json: {
    server: "https://review.example.com/", fetchedAt: new Date().toISOString(), identity: { username: "alex", mode: "username" }, warnings: [], mergedLoaded: false,
    changes: [{ id: "123", sourceUrl, changeNumber: 123, subject, project: "platform/firmware", branch: "main", status: "Active", updated: new Date().toISOString(), owner: change.owner, scopes: ["mine"], group: "action", evidence: "explicit", facts: [], diagnosis: "Needs review", ci: "unknown", requirements: [] }],
  } }));
  await page.goto("/dashboard?server=https%3A%2F%2Freview.example.com%2F&user=alex&project=missing");
  await expect(page.getByText("No changes match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByText(subject, { exact: true })).toBeVisible();
  await noPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("dashboard.png"), fullPage: true });
  expect(await page.getByRole("heading", { name: "My work", exact: true }).evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(140);
  await expect(page.locator(".dashboard-workspace > .dashboard-sidebar")).not.toBeVisible();
  const filtersButton = page.getByRole("button", { name: "Filters", exact: true });
  await filtersButton.click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await filters.getByRole("combobox", { name: "Filter by project", exact: true }).selectOption("platform/firmware");
  await filters.getByRole("button", { name: "All owners", exact: true }).click();
  await filters.getByRole("textbox", { name: "Search change owners" }).fill("Alex");
  await filters.getByRole("checkbox", { name: "Alex Morgan", exact: true }).click();
  await expect(filters.getByRole("checkbox", { name: "Alex Morgan", exact: true })).toBeChecked();
  await filters.getByRole("button", { name: "Alex Morgan", exact: true }).click();
  await filters.getByRole("button", { name: /Work in progress/ }).click();
  await filters.getByRole("button", { name: "Show results", exact: true }).click();
  await expect(filtersButton).toBeFocused();
  await expect(page.getByText("No changes match these filters")).toBeVisible();
  await filtersButton.click();
  await expect(filters.getByRole("button", { name: /Work in progress/ })).toHaveClass("active");
  await filters.getByRole("button", { name: /All changes/ }).click();
  await page.keyboard.press("Escape");
  await expect(filtersButton).toBeFocused();
  await expect(page.getByText(subject, { exact: true })).toBeVisible();
  await noPageOverflow(page);
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Change dashboard profile" })).toBeVisible();
});
