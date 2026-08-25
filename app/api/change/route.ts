import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, parseGerritUrl, publicFetch, resolveChange } from "@/lib/gerrit-server";
import type { ChangeCheck, ChangeData, ComparisonFile, GerritComment, GerritCommentLink, GerritReviewer, RelatedChange } from "@/lib/types";

export const runtime = "nodejs";

type GerritCommentInfo = {
  id: string;
  patch_set: number;
  line?: number;
  side?: "PARENT" | "REVISION";
  parent?: number;
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
type GerritRelatedChange = {
  project: string;
  commit: { commit: string; subject?: string };
  _change_number?: number;
  _revision_number?: number;
  _current_revision_number?: number;
  status?: string;
};
type GerritRelatedChanges = { changes: GerritRelatedChange[] };
type GerritProjectConfig = { commentlinks?: Record<string, GerritCommentLink> };

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

function automationChecks(messages: Array<{ message: string; _revision_number?: number }> | undefined, revisionNumber: number): ChangeCheck[] {
  const checks = (messages ?? [])
    .filter((message) => message._revision_number === revisionNumber)
    .flatMap(({ message }) => [...message.matchAll(/(https?:\/\/\S+?)\s*:\s*(SUCCESS|FAILURE|UNSTABLE|ABORTED|NOT_BUILT)\b/gi)])
    .flatMap((match) => {
      try {
        const url = new URL(match[1]);
        const result = match[2].toUpperCase() as ChangeCheck["result"];
        const parts = url.pathname.split("/").filter(Boolean);
        const jobIndex = parts.lastIndexOf("job");
        const name = jobIndex >= 0 && parts[jobIndex + 1]
          ? `${decodeURIComponent(parts[jobIndex + 1])}${parts[jobIndex + 2] ? ` #${parts[jobIndex + 2]}` : ""}`
          : url.hostname;
        return [{ name, result, url: url.toString() }];
      } catch {
        return [];
      }
    });
  return [...new Map(checks.map((check) => [check.url, check] as const)).values()];
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
      parent: comment.parent,
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

function changeStatus(status: string, workInProgress?: boolean, mergeable?: boolean) {
  if (status === "NEW" && workInProgress) return "WIP";
  if (status === "NEW" && mergeable === false) return "Merge conflict";
  if (status === "NEW") return "Active";
  return status.toLowerCase().replace(/^./, (character) => character.toUpperCase());
}

export async function GET(request: NextRequest) {
  try {
    const sourceUrl = request.nextUrl.searchParams.get("url");
    const requestedBase = request.nextUrl.searchParams.get("base");
    if (!sourceUrl) return NextResponse.json({ error: "Missing Gerrit URL." }, { status: 400 });

    // Modern Gerrit URLs carry the project name, so start this relatively slow
    // request alongside change resolution instead of serializing it afterwards.
    const parsedSource = parseGerritUrl(sourceUrl);
    const hintedProjectConfig = parsedSource.project
      ? fetchOptionalComments(`${parsedSource.origin}/projects/${encodeURIComponent(parsedSource.project)}/config`)
      : Promise.resolve(null);
    const { parsed, detail, revision, revisionNumber } = await resolveChange(sourceUrl);
    const projectConfigPromise = parsedSource.project === detail.project
      ? hintedProjectConfig
      : fetchOptionalComments(`${parsed.origin}/projects/${encodeURIComponent(detail.project)}/config`);
    const selectedRevision = Object.values(detail.revisions).find((item) => item._number === revisionNumber);
    // Preserve the exact message text: /COMMIT_MSG comment lines are relative to it,
    // so trimming leading blank lines would move every displayed/published anchor.
    const commitMessage = selectedRevision?.commit?.message ?? detail.subject;
    const commitSubject = selectedRevision?.commit?.subject?.trim() || commitMessage.split(/\r?\n/, 1)[0]?.trim() || detail.subject;
    // /COMMIT_MSG header, per Gerrit's MagicFile#forCommitMessage: one line per parent
    // (none for a root commit), Author, AuthorDate, Commit, CommitDate, then a blank line.
    const commitMessageLineOffset = (selectedRevision?.commit?.parents?.length ?? 0) + 5;
    const baseRevisionNumber = requestedBase ? Number(requestedBase) : undefined;
    const baseRevision = baseRevisionNumber === undefined
      ? undefined
      : Object.values(detail.revisions).find((item) => item._number === baseRevisionNumber);
    if (baseRevisionNumber !== undefined && (!Number.isInteger(baseRevisionNumber) || baseRevisionNumber < 1 || baseRevisionNumber === revisionNumber || !baseRevision)) {
      return NextResponse.json({ error: "Invalid comparison patchset." }, { status: 400 });
    }
    const baseCommitMessageLineOffset = baseRevision
      ? (baseRevision.commit?.parents?.length ?? 0) + 5
      : undefined;
    const changePath = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}`;
    const revisionPath = `${changePath}/revisions/${encodeURIComponent(revision)}`;
    const [patchResponse, comparison, fileStats, commentsResponse, portedCommentsResponse, relatedResponse, projectConfigResponse] = await Promise.all([
      baseRevisionNumber === undefined ? publicFetch(`${revisionPath}/patch`, "text/plain") : Promise.resolve(null),
      baseRevisionNumber === undefined ? Promise.resolve(undefined) : fetchComparison(changePath, revision, baseRevisionNumber),
      baseRevisionNumber === undefined ? fetchFileStats(revisionPath) : Promise.resolve(undefined),
      fetchOptionalComments(`${changePath}/comments?enable-context=true&context-padding=0`),
      fetchOptionalComments(`${revisionPath}/ported_comments`),
      fetchOptionalComments(`${revisionPath}/related`),
      projectConfigPromise,
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
    const originalsById = new Map(allComments.map((comment) => [comment.id, comment]));
    const portedIds = new Set(portedComments.map((comment) => comment.id));
    // A copied file can produce multiple ported locations with the same Gerrit UUID.
    // Keep every location; the original is replaced only while its ported instances
    // represent it on the selected revision.
    const comments = [
      ...allComments.filter((comment) => !portedIds.has(comment.id)),
      ...portedComments.map((comment) => {
        const original = originalsById.get(comment.id);
        return {
          ...original,
          ...comment,
          contextLines: comment.contextLines ?? original?.contextLines,
          unresolved: original?.unresolved ?? comment.unresolved,
        };
      }),
    ];

    const projectConfig = projectConfigResponse
      ? parseGerritJson<GerritProjectConfig>(await projectConfigResponse.text())
      : {};
    const commentLinks = Object.values(projectConfig.commentlinks ?? {}).filter((link) => link.enabled !== false);
    const relatedChanges = relatedResponse
      ? parseGerritJson<GerritRelatedChanges>(await relatedResponse.text()).changes
      : [];
    const relationChain: RelatedChange[] = relatedChanges.map((related) => {
      const changeNumber = related._change_number;
      const revisionNumber = related._revision_number;
      const sourceUrl = changeNumber
        ? `${parsed.origin}/c/${related.project.split("/").map(encodeURIComponent).join("/")}/+/${changeNumber}${revisionNumber ? `/${revisionNumber}` : ""}`
        : undefined;
      return {
        project: related.project,
        changeNumber,
        revisionNumber,
        currentRevisionNumber: related._current_revision_number,
        subject: related.commit.subject?.trim() || (changeNumber ? `Change ${changeNumber}` : related.commit.commit.slice(0, 12)),
        status: related.status,
        commit: related.commit.commit,
        sourceUrl,
        isCurrent: false,
      };
    });
    const currentRelationIndex = relationChain.findIndex((related) => related.changeNumber === detail._number && related.revisionNumber === revisionNumber);
    if (currentRelationIndex >= 0) relationChain[currentRelationIndex] = { ...relationChain[currentRelationIndex], isCurrent: true };
    else relationChain.push({
      project: detail.project,
      changeNumber: detail._number,
      revisionNumber,
      currentRevisionNumber: Math.max(...Object.values(detail.revisions).map((item) => item._number)),
      subject: commitSubject,
      status: detail.status,
      commit: revision,
      sourceUrl,
      isCurrent: true,
    });

    const accountKey = (account: { _account_id?: number; email?: string; name?: string; display_name?: string }) =>
      account._account_id !== undefined
        ? `id:${account._account_id}`
        : `name:${account.email ?? account.display_name ?? account.name ?? "unknown"}`;
    const labelVotes = (label: string) => new Map(
      (detail.labels?.[label]?.all ?? [])
        .filter((account) => account.value !== undefined)
        .map((account) => [accountKey(account), account.value] as const),
    );
    const codeReviewVotes = labelVotes("Code-Review");
    const verifiedVotes = labelVotes("Verified");
    const currentReviewerAccounts = detail.reviewers?.REVIEWER ?? [];
    const fallbackVoters = [
      ...(detail.labels?.["Code-Review"]?.all ?? []),
      ...(detail.labels?.Verified?.all ?? []),
    ].filter((account) => account.value !== undefined && account.value !== 0);
    const reviewerAccounts = [...new Map(
      (currentReviewerAccounts.length ? currentReviewerAccounts : fallbackVoters)
        .map((account) => [accountKey(account), account] as const),
    ).values()];
    const reviewers: GerritReviewer[] = reviewerAccounts.map((account) => {
      const avatar = account.avatars?.toSorted((a, b) => b.height - a.height)[0]?.url;
      const key = accountKey(account);
      return {
        name: account.display_name ?? account.name ?? account.email ?? account.username ?? "Unknown reviewer",
        email: account.email,
        username: account.username,
        avatarUrl: avatar ? new URL(avatar, parsed.origin).toString() : undefined,
        codeReview: codeReviewVotes.get(key),
        verified: verifiedVotes.get(key),
      };
    });

    const checks = automationChecks(detail.messages, revisionNumber);
    const avatar = detail.owner.avatars?.toSorted((a, b) => b.height - a.height)[0]?.url;
    const avatarUrl = avatar ? new URL(avatar, parsed.origin).toString() : undefined;
    const data: ChangeData = {
      host: parsed.host,
      sshHost: parsed.sshHost,
      sourceUrl,
      changeNumber: detail._number,
      subject: commitSubject,
      commitMessage,
      commentLinks,
      commitMessageLineOffset,
      baseCommitMessageLineOffset,
      project: detail.project,
      branch: detail.branch,
      status: changeStatus(detail.status, detail.work_in_progress, detail.mergeable),
      owner: {
        name: detail.owner.display_name ?? detail.owner.name ?? detail.owner.email ?? detail.owner.username ?? "Unknown author",
        email: detail.owner.email,
        username: detail.owner.username,
        avatarUrl,
      },
      reviewers,
      checks,
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
      comments: comments.toSorted((a, b) => a.updated.localeCompare(b.updated)),
      relationChain,
    };

    return NextResponse.json(data, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't load this change.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
