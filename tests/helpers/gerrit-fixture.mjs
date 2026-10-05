export const source = "https://8.8.8.8/c/project/+/100";
export const ps1 = "1".repeat(40);
export const ps2 = "2".repeat(40);
export const parentContent = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
export const ps1Content = parentContent.replace("line 3\n", "ps1 line 3\n");
export const ps2Content = parentContent.replace("line 3\n", "ps2 line 3\n").replace("line 50\n", "ps2 line 50\n");
const patch = "diff --git a/f.c b/f.c\n--- a/f.c\n+++ b/f.c\n@@ -1,5 +1,5 @@\n line 1\n line 2\n-line 3\n+ps2 line 3\n line 4\n line 5\n@@ -48,5 +48,5 @@\n line 48\n line 49\n-line 50\n+ps2 line 50\n line 51\n line 52\n";
const json = (body) => new Response(`)]}'\n${JSON.stringify(body)}`);
const encoded = (body) => new Response(Buffer.from(body).toString("base64"));

export function mockGerritFetch(input) {
  const url = new URL(input);
  if (url.pathname.endsWith("/detail")) return json({
    _number: 100, subject: "Subject", project: "project", branch: "main", status: "NEW", owner: { name: "Alice" }, current_revision: ps2,
    revisions: {
      [ps1]: { _number: 1, commit: { subject: "Subject 1", message: "Subject 1", parents: [{ commit: "a".repeat(40) }] } },
      [ps2]: { _number: 2, commit: { subject: "Subject 2", message: "Subject 2", parents: [{ commit: "a".repeat(40) }] } },
    }, updated: "2026-01-01 00:00:00",
  });
  if (url.pathname.endsWith("/patch")) return encoded(patch);
  if (url.pathname.endsWith("/content")) return encoded(url.searchParams.has("parent") ? parentContent : url.pathname.includes(`/revisions/${ps2}/`) ? ps2Content : ps1Content);
  if (url.pathname.endsWith("/files")) return json({ "f.c": { lines_inserted: 2, lines_deleted: 2 } });
  if (url.pathname.endsWith("/comments")) return json({ "f.c": [
    { id: "parent-comment", patch_set: 2, line: 3, side: "PARENT", message: "Parent comment", author: { name: "Alice" }, updated: "2026-01-01 00:00:00" },
    { id: "revision-comment", patch_set: 2, line: 50, message: "Revision comment", author: { name: "Alice" }, updated: "2026-01-01 00:01:00" },
  ] });
  return new Response("Not found", { status: 404 });
}
