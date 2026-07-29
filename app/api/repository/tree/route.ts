import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, publicFetch, resolveChange } from "@/lib/gerrit-server";

export const runtime = "nodejs";

type ProjectInfo = {
  web_links?: Array<{ name?: string; url?: string }>;
};

type GitilesTree = {
  entries?: Array<{ name: string; type: "tree" | "blob" }>;
};

function encodePath(path: string) {
  return path.split("/").flatMap((segment) => segment ? [encodeURIComponent(segment)] : []).join("/");
}

export async function GET(request: NextRequest) {
  try {
    const sourceUrl = request.nextUrl.searchParams.get("url");
    const path = request.nextUrl.searchParams.get("path")?.replace(/^\/+|\/+$/g, "") ?? "";
    if (!sourceUrl) return NextResponse.json({ error: "Missing Gerrit URL." }, { status: 400 });

    const { parsed, detail, revision } = await resolveChange(sourceUrl);
    const projectResponse = await publicFetch(`${parsed.origin}/projects/${encodeURIComponent(detail.project)}`);
    if (!projectResponse) throw new Error("Project not found.");
    const project = parseGerritJson<ProjectInfo>(await projectResponse.text());
    const gitilesBase = project.web_links?.find((link) => link.name?.toLowerCase().includes("gitiles") && link.url)?.url;
    if (!gitilesBase) {
      return NextResponse.json({ error: "This Gerrit server does not advertise a Gitiles repository browser.", available: false }, { status: 501 });
    }

    const pathPart = path ? `${encodePath(path)}/` : "";
    const treeUrl = `${gitilesBase.replace(/\/$/, "")}/+show/${encodeURIComponent(revision)}/${pathPart}?format=JSON`;
    const treeResponse = await publicFetch(treeUrl);
    if (!treeResponse) throw new Error("Directory not found.");
    const tree = parseGerritJson<GitilesTree>(await treeResponse.text());
    const entries = (tree.entries ?? []).slice(0, 10_000).map((entry) => ({
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      type: entry.type === "tree" ? "directory" : "file",
    }));

    return NextResponse.json({ available: true, path, entries }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't browse this repository.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
