import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pierre 1.2.12 includes layout.paddingTop in navigation and DOM placement, but
// not its virtual window. Large overview padding otherwise drops visible lines.
// Keep this narrow, idempotent correction until the dependency fixes it upstream.
const path = join(dirname(fileURLToPath(import.meta.resolve("@pierre/diffs"))), "components/CodeView.js");
const source = readFileSync(path, "utf8");
const before = "scrollTop: targetScrollTop,\n\t\t\theight: viewportHeight,";
const after = "scrollTop: targetScrollTop - this.getLayout().paddingTop,\n\t\t\theight: viewportHeight,";
if (!source.includes(after)) {
  if (source.split(before).length !== 2) {
    throw new Error("Pierre CodeView padding fix no longer matches. Re-evaluate scripts/patch-pierre-diffs.mjs before upgrading @pierre/diffs.");
  }
  writeFileSync(path, source.replace(before, after));
}
