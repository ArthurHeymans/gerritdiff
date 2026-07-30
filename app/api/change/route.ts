import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, publicFetch, resolveChange } from "@/lib/gerrit-server";
import type { ChangeData, GerritComment } from "@/lib/types";

export const runtime = "nodejs";

type GerritCommentInfo = {
  id: string;
  patch_set: number;
  line?: number;
  side?: "PARENT" | "REVISION";
  range?: { start_line: number; start_character: number; end_line: number; end_character: number };
  context_lines?: { line_number: number; context_line: string }[];
  author?: { name?: string; display_name?: string; email?: string; avatars?: { url: string; height: number }[] };
  message: string;
  updated: string;
  unresolved?: boolean;
  in_reply_to?: string;
};

type GerritComments = Record<string, GerritCommentInfo[]>;

async function fetchOptionalComments(url: string) {
  try {
    return await publicFetch(url, "application/json", true);
  } catch {
    return null;
  }
}

function normalizeComments(input: GerritComments, origin: string, ported = false): GerritComment[] {
  return Object.entries(input).flatMap(([path, comments]) => comments.map((comment) => {
    const avatar = comment.author?.avatars?.toSorted((a, b) => b.height - a.height)[0]?.url;
    let avatarUrl: string | undefined;
    try {
      avatarUrl = avatar ? new URL(avatar, origin).toString() : undefined;
    } catch {
      avatarUrl = undefined;
    }
    return {
      id: comment.id,
      path,
      patchSet: comment.patch_set,
      line: comment.line,
      side: comment.side ?? "REVISION",
      range: comment.range ? {
        startLine: comment.range.start_line,
        startCharacter: comment.range.start_character,
        endLine: comment.range.end_line,
        endCharacter: comment.range.end_character,
      } : undefined,
      contextLines: comment.context_lines?.map((line) => ({ lineNumber: line.line_number, text: line.context_line })),
      author: {
        name: comment.author?.display_name ?? comment.author?.name ?? "Gerrit reviewer",
        email: comment.author?.email,
        avatarUrl,
      },
      message: comment.message,
      updated: comment.updated,
      unresolved: comment.unresolved ?? false,
      inReplyTo: comment.in_reply_to,
      ported,
    };
  }));
}

export async function GET(request: NextRequest) {
  try {
    const sourceUrl = request.nextUrl.searchParams.get("url");
    if (!sourceUrl) return NextResponse.json({ error: "Missing Gerrit URL." }, { status: 400 });

    const { parsed, detail, revision, revisionNumber } = await resolveChange(sourceUrl);
    const changePath = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}`;
    const revisionPath = `${changePath}/revisions/${encodeURIComponent(revision)}`;
    const [patchResponse, commentsResponse, portedCommentsResponse] = await Promise.all([
      publicFetch(`${revisionPath}/patch`, "text/plain"),
      fetchOptionalComments(`${changePath}/comments?enable-context=true&context-padding=0`),
      fetchOptionalComments(`${revisionPath}/ported_comments`),
    ]);
    if (!patchResponse) throw new Error("Patch not found.");
    const patchBody = await patchResponse.text();
    const encodedPatch = patchBody.trim();
    if (encodedPatch.length > 40_000_000) throw new Error("This patch is too large for the hosted viewer.");
    const patch = Buffer.from(encodedPatch, "base64").toString("utf8");

    const allComments = commentsResponse
      ? normalizeComments(parseGerritJson<GerritComments>(await commentsResponse.text()), parsed.origin)
      : [];
    const portedComments = portedCommentsResponse
      ? normalizeComments(parseGerritJson<GerritComments>(await portedCommentsResponse.text()), parsed.origin, true)
      : [];
    const commentsById = new Map(allComments.map((comment) => [comment.id, comment]));
    for (const comment of portedComments) {
      const original = commentsById.get(comment.id);
      commentsById.set(comment.id, { ...comment, contextLines: comment.contextLines ?? original?.contextLines });
    }

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
      comments: [...commentsById.values()].toSorted((a, b) => a.updated.localeCompare(b.updated)),
    };

    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't load this change.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
