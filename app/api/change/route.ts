import { NextRequest, NextResponse } from "next/server";
import { publicFetch, resolveChange } from "@/lib/gerrit-server";
import type { ChangeData } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const sourceUrl = request.nextUrl.searchParams.get("url");
    if (!sourceUrl) return NextResponse.json({ error: "Missing Gerrit URL." }, { status: 400 });

    const { parsed, detail, revision, revisionNumber } = await resolveChange(sourceUrl);
    const patchUrl = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}/revisions/${encodeURIComponent(revision)}/patch`;
    const patchResponse = await publicFetch(patchUrl, "text/plain");
    if (!patchResponse) throw new Error("Patch not found.");
    const patchBody = await patchResponse.text();
    const encodedPatch = patchBody.trim();
    if (encodedPatch.length > 40_000_000) throw new Error("This patch is too large for the hosted viewer.");
    const patch = Buffer.from(encodedPatch, "base64").toString("utf8");

    const avatar = detail.owner.avatars?.toSorted((a, b) => b.height - a.height)[0]?.url;
    const avatarUrl = avatar ? new URL(avatar, parsed.origin).toString() : undefined;
    const data: ChangeData = {
      host: parsed.host,
      sourceUrl,
      changeNumber: detail._number,
      subject: detail.subject,
      project: detail.project,
      branch: detail.branch,
      status: detail.status,
      owner: {
        name: detail.owner.display_name ?? detail.owner.name ?? "Unknown author",
        email: detail.owner.email,
        avatarUrl,
      },
      revision,
      revisionNumber,
      updated: detail.updated,
      insertions: detail.insertions ?? 0,
      deletions: detail.deletions ?? 0,
      patch,
    };

    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't load this change.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
