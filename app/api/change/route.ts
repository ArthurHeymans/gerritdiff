import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, publicFetch, resolveChange } from "@/lib/gerrit-server";
import type { ChangeData, ComparisonFile, GerritComment } from "@/lib/types";

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
type GerritFileInfo = {
  status?: "A" | "D" | "R" | "C";
  old_path?: string;
  lines_inserted?: number;
  lines_deleted?: number;
};
type GerritFiles = Record<string, GerritFileInfo>;

async function fetchRevisionContent(changePath: string, revision: string | number, path: string) {
  const response = await publicFetch(`${changePath}/revisions/${encodeURIComponent(revision)}/files/${encodeURIComponent(path)}/content`, "text/plain", true);
  if (!response) return undefined;
  const encoded = (await response.text()).trim();
  if (encoded.length > 16_000_000) throw new Error(`${path} is too large to compare.`);
  return Buffer.from(encoded, "base64");
}

async function fetchFileStats(revisionPath: string) {
  const response = await publicFetch(`${revisionPath}/files`);
  if (!response) return undefined;
  const entries = Object.entries(parseGerritJson<GerritFiles>(await response.text())).filter(([path]) => !path.startsWith("/"));
  return {
    insertions: entries.reduce((sum, [, info]) => sum + (info.lines_inserted ?? 0), 0),
    deletions: entries.reduce((sum, [, info]) => sum + (info.lines_deleted ?? 0), 0),
  };
}

async function fetchComparison(changePath: string, targetRevision: string, baseRevision: number) {
  const response = await publicFetch(`${changePath}/revisions/${encodeURIComponent(targetRevision)}/files?base=${encodeURIComponent(baseRevision)}`);
  if (!response) throw new Error("Comparison not found.");
  const entries = Object.entries(parseGerritJson<GerritFiles>(await response.text())).filter(([path]) => !path.startsWith("/"));
  const files: ComparisonFile[] = [];
  let totalSize = 0;
  const comparisonConcurrency = 4;
  for (let index = 0; index < entries.length; index += comparisonConcurrency) {
    const batch = await Promise.all(entries.slice(index, index + comparisonConcurrency).map(async ([path, info]) => {
      const previousName = info.old_path;
      const [base, target] = await Promise.all([
        fetchRevisionContent(changePath, baseRevision, previousName ?? path),
        fetchRevisionContent(changePath, targetRevision, path),
      ]);
      totalSize += (base?.byteLength ?? 0) + (target?.byteLength ?? 0);
      if (totalSize > 40_000_000) throw new Error("This patchset comparison is too large for the hosted viewer.");
      const binary = Boolean(base?.subarray(0, 8_000).includes(0) || target?.subarray(0, 8_000).includes(0));
      return {
        name: path,
        previousName,
        status: info.status ?? "M",
        baseContent: binary ? undefined : base?.toString("utf8"),
        targetContent: binary ? undefined : target?.toString("utf8"),
        binary,
      } satisfies ComparisonFile;
    }));
    files.push(...batch);
  }
  return {
    files,
    insertions: entries.reduce((sum, [, info]) => sum + (info.lines_inserted ?? 0), 0),
    deletions: entries.reduce((sum, [, info]) => sum + (info.lines_deleted ?? 0), 0),
  };
}

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
    const requestedBase = request.nextUrl.searchParams.get("base");
    if (!sourceUrl) return NextResponse.json({ error: "Missing Gerrit URL." }, { status: 400 });

    const { parsed, detail, revision, revisionNumber } = await resolveChange(sourceUrl);
    const selectedRevision = Object.values(detail.revisions).find((item) => item._number === revisionNumber);
    const commitMessage = selectedRevision?.commit?.message?.trim() || detail.subject;
    const commitSubject = selectedRevision?.commit?.subject?.trim() || commitMessage.split(/\r?\n/, 1)[0] || detail.subject;
    const baseRevisionNumber = requestedBase ? Number(requestedBase) : undefined;
    if (baseRevisionNumber !== undefined && (!Number.isInteger(baseRevisionNumber) || baseRevisionNumber < 1 || baseRevisionNumber === revisionNumber || !Object.values(detail.revisions).some((item) => item._number === baseRevisionNumber))) {
      return NextResponse.json({ error: "Invalid comparison patchset." }, { status: 400 });
    }
    const changePath = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}`;
    const revisionPath = `${changePath}/revisions/${encodeURIComponent(revision)}`;
    const [patchResponse, comparison, fileStats, commentsResponse, portedCommentsResponse] = await Promise.all([
      baseRevisionNumber === undefined ? publicFetch(`${revisionPath}/patch`, "text/plain") : Promise.resolve(null),
      baseRevisionNumber === undefined ? Promise.resolve(undefined) : fetchComparison(changePath, revision, baseRevisionNumber),
      baseRevisionNumber === undefined ? fetchFileStats(revisionPath) : Promise.resolve(undefined),
      fetchOptionalComments(`${changePath}/comments?enable-context=true&context-padding=0`),
      fetchOptionalComments(`${revisionPath}/ported_comments`),
    ]);
    let patch = "";
    if (patchResponse) {
      const encodedPatch = (await patchResponse.text()).trim();
      if (encodedPatch.length > 40_000_000) throw new Error("This patch is too large for the hosted viewer.");
      patch = Buffer.from(encodedPatch, "base64").toString("utf8");
    }

    const allComments = commentsResponse
      ? normalizeComments(parseGerritJson<GerritComments>(await commentsResponse.text()), parsed.origin)
      : [];
    const portedComments = portedCommentsResponse
      ? normalizeComments(parseGerritJson<GerritComments>(await portedCommentsResponse.text()), parsed.origin, true)
      : [];
    const commentsById = new Map(allComments.map((comment) => [comment.id, comment]));
    for (const comment of portedComments) {
      const original = commentsById.get(comment.id);
      commentsById.set(comment.id, {
        ...original,
        ...comment,
        contextLines: comment.contextLines ?? original?.contextLines,
        unresolved: original?.unresolved ?? comment.unresolved,
      });
    }

    const avatar = detail.owner.avatars?.toSorted((a, b) => b.height - a.height)[0]?.url;
    const avatarUrl = avatar ? new URL(avatar, parsed.origin).toString() : undefined;
    const data: ChangeData = {
      host: parsed.host,
      sourceUrl,
      changeNumber: detail._number,
      subject: commitSubject,
      commitMessage,
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
      revisions: Object.entries(detail.revisions)
        .map(([revisionId, info]) => ({
          revision: revisionId,
          number: info._number,
          created: info.created,
          uploader: info.uploader?.display_name ?? info.uploader?.name,
        }))
        .toSorted((a, b) => a.number - b.number),
      baseRevisionNumber,
      comparisonFiles: comparison?.files,
      updated: detail.updated,
      insertions: comparison?.insertions ?? fileStats?.insertions ?? detail.insertions ?? 0,
      deletions: comparison?.deletions ?? fileStats?.deletions ?? detail.deletions ?? 0,
      patch,
      comments: [...commentsById.values()].toSorted((a, b) => a.updated.localeCompare(b.updated)),
    };

    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't load this change.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
