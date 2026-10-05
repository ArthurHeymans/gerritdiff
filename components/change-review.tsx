"use client";

import {
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
  DEFAULT_THEMES,
  areSelectionsEqual,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Check, ChevronDown, ChevronUp, CircleCheck, Columns2, Copy, ExternalLink, FileText, GitBranch, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Pilcrow, Quote, Reply, Rows3, Search, Send, Settings2, Terminal, Trash2, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type FileSnapshotOption, MovedCodeCompare } from "@/components/moved-code-compare";
import { RepositoryBrowser } from "@/components/repository-browser";
import { createCodeViewDiffOptions, textMatchRanges, textPosition, updateWhitespaceMarkers } from "@/lib/code-view";
import { normalizeGerritServer, patchsetUrl } from "@/lib/gerrit-url";
import { gerritDiffHref, linkifyText } from "@/lib/linkify";
import type { ChangeData, GerritComment, GerritCommentLink, RelatedChange } from "@/lib/types";
import type { GerritDiffTheme } from "@/lib/theme";

type DiscussionThread = { key: string; id: string; path: string; comments: GerritComment[] };

type GerritTextRange = { start_line: number; start_character: number; end_line: number; end_character: number };

type CommentMetadata =
  | { kind: "draft"; key: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; unresolved?: boolean }
  | { kind: "saved"; key: string; author: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; unresolved?: boolean }
  | { kind: "existing"; key: string; range: SelectedLineRange; textRange?: GerritTextRange; thread: DiscussionThread };

type ActiveDraft = { itemId: string; key: string };
type RightPanel = { kind: "relation" } | { kind: "scope"; path: string } | { kind: "discussion"; threadKey: string } | null;
type LocalReply = { key: string; message: string; resolved: boolean };
type LocalReviewComment = { key: string; path: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; gerritLine?: number; gerritRange?: GerritTextRange; parent?: number; inReplyTo?: string; unresolved?: boolean };
type CodeTextSelection = { itemId: string; range: SelectedLineRange; textRange: GerritTextRange; top: number; left: number };
type SearchMatch = { itemId: string; lineNumber: number; side?: "deletions" | "additions" };
type GerritCommentInput = {
  // Omitted for /PATCHSET_LEVEL comments; Gerrit defaults to REVISION.
  side?: "PARENT" | "REVISION";
  parent?: number;
  line?: number;
  range?: { start_line: number; start_character: number; end_line: number; end_character: number };
  in_reply_to?: string;
  message: string;
  unresolved?: boolean;
};

const COMMENT_HIGHLIGHT_NAME = "gerrit-comment-range";
const SEARCH_HIGHLIGHT_NAME = "gerrit-search-result";
const ACTIVE_SEARCH_HIGHLIGHT_NAME = "gerrit-search-result-active";
const WORKER_POOL_OPTIONS = {
  poolSize: 3,
  totalASTLRUCacheSize: 100,
  workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url)),
};
const WORKER_HIGHLIGHTER_OPTIONS = {
  theme: DEFAULT_THEMES,
  langs: ["cpp", "css", "go", "python", "rust", "sh", "swift", "tsx", "typescript", "zig"],
  preferredHighlighter: "shiki-wasm" as const,
};

type ContentResponse = {
  exists: boolean;
  binary?: boolean;
  content?: string;
  error?: string;
};

async function fetchFileContent(sourceUrl: string, path: string, parent?: number) {
  const query = new URLSearchParams({ url: sourceUrl, path });
  if (parent) query.set("parent", String(parent));
  const response = await fetch(`/api/repository/content?${query}`);
  const body = await response.json() as ContentResponse;
  if (!response.ok) throw new Error(body.error ?? `Couldn’t load ${path}.`);
  return body;
}

function nextVersion(item: CodeViewItem<CommentMetadata>) {
  return (item.version ?? 0) + 1;
}

function isDiffItem(item: CodeViewItem<CommentMetadata>): item is CodeViewDiffItem<CommentMetadata> {
  return item.type === "diff";
}

type ProjectUiSettings = {
  tabSize?: number;
  diffStyle?: "split" | "unified";
  showWhitespace?: boolean;
  ignoreIndentation?: boolean;
  sidebarCollapsed?: boolean;
  sidebarMode?: "changed" | "repository" | "discussion";
};

const REVIEWERS_EXPANDED_STORAGE_KEY = "gerritdiff:reviewers-expanded";

function readReviewersExpanded() {
  try {
    return window.localStorage.getItem(REVIEWERS_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveReviewersExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(REVIEWERS_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // Keep the in-memory preference when browser storage is unavailable.
  }
}

function personDashboardHref(data: ChangeData, returnTo: string | undefined, person: { name: string; email?: string; username?: string }) {
  const owner = person.email ?? person.username ?? person.name;
  try {
    const url = new URL(returnTo ?? "/dashboard", "https://gerritdiff.local");
    url.pathname = "/dashboard";
    if (!url.searchParams.has("server")) url.searchParams.set("server", normalizeGerritServer(data.sourceUrl).toString());
    if (!url.searchParams.has("user")) {
      const fallbackUser = data.owner.email ?? data.owner.username ?? person.email ?? person.username;
      if (!fallbackUser) return null;
      url.searchParams.set("user", fallbackUser);
    }
    url.searchParams.set("scope", "all");
    url.searchParams.set("state", "all");
    url.searchParams.delete("owner");
    url.searchParams.append("owner", owner);
    for (const filter of ["wip", "project", "topic", "age", "sort"]) url.searchParams.delete(filter);
    return `${url.pathname}?${url.searchParams}`;
  } catch {
    return null;
  }
}

function projectUiStorageKey(host: string, project: string) {
  return `gerritdiff:ui:${host}:${project}`;
}

function readProjectUiSettings(host: string, project: string): ProjectUiSettings {
  try {
    const settings: unknown = JSON.parse(window.localStorage.getItem(projectUiStorageKey(host, project)) ?? "{}");
    return settings && typeof settings === "object" ? settings as ProjectUiSettings : {};
  } catch {
    return {};
  }
}

function saveProjectUiSettings(host: string, project: string, update: Partial<ProjectUiSettings>) {
  try {
    const settings = { ...readProjectUiSettings(host, project), ...update };
    window.localStorage.setItem(projectUiStorageKey(host, project), JSON.stringify(settings));
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

function gitStatusFor(file: FileDiffMetadata): GitStatus {
  if (file.type === "new") return "added";
  if (file.type === "deleted") return "deleted";
  if (file.type === "rename-pure" || file.type === "rename-changed") return "renamed";
  return "modified";
}

function commentInstanceKey(comment: GerritComment) {
  const range = comment.range;
  return JSON.stringify([
    comment.id,
    comment.path,
    comment.line ?? null,
    range?.startLine ?? null,
    range?.startCharacter ?? null,
    range?.endLine ?? null,
    range?.endCharacter ?? null,
  ]);
}

function buildDiscussionThreads(comments: GerritComment[]): DiscussionThread[] {
  const byId = new Map<string, GerritComment[]>();
  for (const comment of comments) byId.set(comment.id, [...(byId.get(comment.id) ?? []), comment]);
  const grouped = new Map<string, { id: string; comments: GerritComment[] }>();
  for (const comment of comments) {
    let root = comment;
    const visited = new Set([comment.id]);
    while (root.inReplyTo) {
      const candidates = byId.get(root.inReplyTo) ?? [];
      // Copied files can produce several ported instances with the same UUID.
      // Follow the parent at this instance's path rather than collapsing them.
      const parent = candidates.find((candidate) => candidate.path === root.path) ?? candidates[0];
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      root = parent;
    }
    const key = commentInstanceKey(root);
    const group = grouped.get(key) ?? { id: root.id, comments: [] };
    group.comments.push(comment);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, group]) => {
    const sorted = group.comments.toSorted((a, b) => a.updated.localeCompare(b.updated));
    return { key, id: group.id, path: sorted[0]?.path ?? "/PATCHSET_LEVEL", comments: sorted };
  }).toSorted((a, b) => (b.comments.at(-1)?.updated ?? "").localeCompare(a.comments.at(-1)?.updated ?? ""));
}

function threadAnchor(thread: DiscussionThread, revisionNumber: number) {
  return thread.comments.find((comment) => (comment.patchSet === revisionNumber || comment.ported) && (comment.line || comment.range));
}

function threadPatchset(thread: DiscussionThread) {
  return thread.comments[0]?.patchSet;
}

// A Gerrit comment with a path but no line/range is a file-level comment; with the
// reserved /PATCHSET_LEVEL path it applies to the whole patchset.
function threadIsFileLevel(thread: DiscussionThread) {
  const first = thread.comments[0];
  return thread.path !== "/PATCHSET_LEVEL" && !first?.line && !first?.range;
}

function threadIsUnanchored(thread: DiscussionThread) {
  return thread.path === "/PATCHSET_LEVEL" || threadIsFileLevel(thread);
}

function threadBelongsToPatchset(thread: DiscussionThread, revisionNumber: number) {
  return Boolean(threadAnchor(thread, revisionNumber)) || (threadIsUnanchored(thread) && threadPatchset(thread) === revisionNumber);
}

function scopeLabel(path: string) {
  return path === "/PATCHSET_LEVEL" ? "Patchset comments" : path === "/COMMIT_MSG" ? "Commit message comments" : "File comments";
}

function shiftCommitMessageComment(comment: GerritComment, offset: number): GerritComment {
  const shiftedLine = comment.line === undefined ? undefined : comment.line + offset;
  const shiftedRange = comment.range
    ? { ...comment.range, startLine: comment.range.startLine + offset, endLine: comment.range.endLine + offset }
    : undefined;
  const visibleRange = shiftedRange && shiftedRange.startLine > 0 && shiftedRange.endLine > 0 ? shiftedRange : undefined;
  return {
    ...comment,
    // The viewer intentionally omits Gerrit's generated header. Header comments
    // therefore remain panel-only instead of being falsely clamped to message line 1.
    line: (!comment.range || visibleRange) && shiftedLine !== undefined && shiftedLine > 0 ? shiftedLine : undefined,
    range: visibleRange,
    gerritLine: comment.line,
    gerritRange: comment.range,
  };
}

function commentRange(comment: GerritComment): SelectedLineRange {
  const side = comment.side === "PARENT" ? "deletions" : "additions";
  return { start: comment.range?.startLine ?? comment.line ?? 0, end: comment.range?.endLine ?? comment.line ?? 0, side, endSide: side };
}

function commentTextRange(comment: GerritComment): GerritTextRange | undefined {
  return comment.range ? {
    start_line: comment.range.startLine,
    start_character: comment.range.startCharacter,
    end_line: comment.range.endLine,
    end_character: comment.range.endCharacter,
  } : undefined;
}

function lineElementFor(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-line]");
}

function selectionSide(line: HTMLElement) {
  if (line.closest("[data-deletions]")) return "deletions" as const;
  if (line.closest("[data-additions]")) return "additions" as const;
  return "additions" as const;
}

function characterOffset(line: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(line);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

function textRangeLabel(range: GerritTextRange) {
  return range.start_line === range.end_line
    ? `Line ${range.start_line}, characters ${range.start_character + 1}–${range.end_character}`
    : `Lines ${range.start_line}:${range.start_character + 1}–${range.end_line}:${range.end_character}`;
}

function highlightedTextRanges(root: ShadowRoot, textRange: GerritTextRange, side: "deletions" | "additions", isDiff: boolean) {
  const ranges: Range[] = [];
  for (let lineNumber = textRange.start_line; lineNumber <= textRange.end_line; lineNumber++) {
    const line = [...root.querySelectorAll<HTMLElement>(`[data-line="${lineNumber}"]`)].find((candidate) => !isDiff || selectionSide(candidate) === side);
    if (!line) continue;
    const startCharacter = lineNumber === textRange.start_line ? textRange.start_character : 0;
    const endCharacter = lineNumber === textRange.end_line ? textRange.end_character : (line.textContent?.length ?? 0);
    const start = textPosition(line, startCharacter);
    const end = textPosition(line, endCharacter);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

function commentInput(comment: LocalReviewComment, file: FileDiffMetadata | undefined, lineOffset: number): GerritCommentInput {
  const side = comment.range.endSide ?? comment.range.side ?? "additions";
  // Gerrit rejects a patchset-level comment that carries side, line or range
  // (CommentsValidator#ensureValidPatchsetLevelComment).
  if (comment.path === "/PATCHSET_LEVEL") {
    const patchsetInput: GerritCommentInput = { message: comment.message };
    if (comment.inReplyTo) patchsetInput.in_reply_to = comment.inReplyTo;
    if (comment.unresolved !== undefined) patchsetInput.unresolved = comment.unresolved;
    return patchsetInput;
  }
  const offset = comment.path === "/COMMIT_MSG" ? lineOffset : 0;
  const input: GerritCommentInput = {
    side: side === "deletions" ? "PARENT" : "REVISION",
    message: comment.message,
  };
  if (comment.parent !== undefined) input.parent = comment.parent;
  if (comment.inReplyTo) input.in_reply_to = comment.inReplyTo;
  if (comment.unresolved !== undefined) input.unresolved = comment.unresolved;
  // Replies to /COMMIT_MSG comments retain their exact server coordinates,
  // including comments in the generated header that the viewer does not render.
  if (comment.gerritRange) {
    input.range = {
      start_line: comment.gerritRange.start_line,
      start_character: comment.gerritRange.start_character,
      end_line: comment.gerritRange.end_line,
      end_character: comment.gerritRange.end_character,
    };
    return input;
  }
  if (comment.gerritLine !== undefined) {
    input.line = comment.gerritLine;
    return input;
  }
  if (comment.textRange) {
    input.range = offset
      ? { ...comment.textRange, start_line: comment.textRange.start_line + offset, end_line: comment.textRange.end_line + offset }
      : comment.textRange;
    return input;
  }
  if (comment.range.start === comment.range.end || !file) {
    if (comment.range.end > 0) input.line = comment.range.end + offset;
    return input;
  }
  const hunk = file.hunks.find((candidate) => {
    const start = side === "deletions" ? candidate.deletionStart : candidate.additionStart;
    const count = side === "deletions" ? candidate.deletionCount : candidate.additionCount;
    return comment.range.end >= start && comment.range.end < start + count;
  });
  const start = hunk ? (side === "deletions" ? hunk.deletionStart : hunk.additionStart) : 0;
  const lineIndex = hunk ? (side === "deletions" ? hunk.deletionLineIndex : hunk.additionLineIndex) + comment.range.end - start : -1;
  const lineText = side === "deletions" ? file.deletionLines[lineIndex] : file.additionLines[lineIndex];
  if (lineText === undefined) {
    input.line = comment.range.end + offset;
    return input;
  }
  input.range = {
    start_line: comment.range.start + offset,
    start_character: 0,
    end_line: comment.range.end + offset,
    end_character: lineText.length,
  };
  return input;
}

function shellArg(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commentPathLabel(path: string) {
  if (path === "/PATCHSET_LEVEL") return "Patchset-level comment";
  if (path === "/COMMIT_MSG") return "Commit message";
  return path;
}

function commentLocationLabel(comment: LocalReviewComment) {
  if (comment.path === "/PATCHSET_LEVEL") return "Whole patchset · not attached to a file";
  const side = (comment.range.endSide ?? comment.range.side) === "deletions" ? "base" : "revision";
  const start = comment.textRange?.start_line ?? comment.range.start;
  const end = comment.textRange?.end_line ?? comment.range.end;
  if (!end) return `Whole file · ${side}`;
  return start && start !== end ? `Lines ${start}–${end} · ${side}` : `Line ${end} · ${side}`;
}

function reviewCommand(host: string, port: string, user: string, project: string, change: number, patchset: number, input: Record<string, unknown>, heredoc = "GERRIT_REVIEW") {
  const destination = `${user.trim() || "YOUR_USERNAME"}@${host}`;
  // ssh joins all command arguments into one string before Gerrit parses it. Quote
  // the complete remote command locally, while retaining quotes around the project
  // for Gerrit's own command-line splitter (the second parsing layer).
  const remoteCommand = `gerrit review --project ${shellArg(project)} --json ${change},${patchset}`;
  return `ssh -p ${shellArg(port.trim() || "29418")} -- ${shellArg(destination)} ${shellArg(remoteCommand)} <<'${heredoc}'\n${JSON.stringify(input, null, 2)}\n${heredoc}`;
}

function DraftComment({
  annotation,
  itemId,
  onCancel,
  onSave,
}: {
  annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>;
  itemId: string;
  onCancel(itemId: string, key: string): void;
  onSave(itemId: string, key: string, message: string, unresolved: boolean): void;
}) {
  const metadata = annotation.metadata?.kind === "draft" ? annotation.metadata : undefined;
  const [message, setMessage] = useState(metadata?.message ?? "");
  const [unresolved, setUnresolved] = useState(metadata?.unresolved ?? true);
  const key = metadata?.key ?? "";
  const trimmed = message.trim();

  return (
    <form
      className={`comment-card comment-draft ${unresolved ? "thread-unresolved" : "thread-resolved"}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave(itemId, key, trimmed, unresolved);
      }}
    >
      <div className="comment-avatar">You</div>
      <div className="comment-compose">
        {metadata?.textRange && <span className="comment-text-range">{textRangeLabel(metadata.textRange)}</span>}
        <textarea
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel(itemId, key);
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && trimmed) onSave(itemId, key, trimmed, unresolved);
          }}
          placeholder="Add a comment…"
          rows={2}
        />
        <div className="comment-actions">
          <button type="submit" disabled={!trimmed}><Send size={13} /> {metadata?.message ? "Save comment" : "Add comment"}</button>
          <button
            className={`resolution-toggle ${unresolved ? "is-unresolved" : "is-resolved"}`}
            type="button"
            aria-pressed={!unresolved}
            title="Unresolved comments block until someone marks them done."
            onClick={() => setUnresolved((current) => !current)}
          >
            <CircleCheck size={12} /> {unresolved ? "Unresolved" : "Resolved"}
          </button>
          <span>Ctrl ↵ to submit</span>
          <button type="button" className="comment-cancel" onClick={() => onCancel(itemId, key)}><X size={14} /> Cancel</button>
        </div>
      </div>
    </form>
  );
}

function SavedComment({
  annotation,
  itemId,
  onDelete,
  onSelect,
  onEdit,
  onToggleResolved,
}: {
  annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>;
  itemId: string;
  onDelete(itemId: string, key: string): void;
  onSelect(selection: CodeViewLineSelection | null): void;
  onEdit(itemId: string, key: string): void;
  onToggleResolved(itemId: string, key: string): void;
}) {
  const metadata = annotation.metadata;
  if (!metadata || metadata.kind !== "saved") return null;
  const unresolved = metadata.unresolved ?? true;
  return (
    <div className={`comment-card saved-comment ${unresolved ? "thread-unresolved" : "thread-resolved"}`} onClick={() => onSelect(metadata.textRange ? null : { id: itemId, range: metadata.range })}>
      <div className="comment-avatar">{metadata.author.slice(0, 2).toUpperCase()}</div>
      <div className="saved-comment-body">
        <div>
          <strong>{metadata.author}</strong>
          <span>Draft · not published</span>
          {metadata.textRange && <span className="comment-text-range">{textRangeLabel(metadata.textRange)}</span>}
          <span className="thread-state">{unresolved ? "Unresolved" : "Resolved"}</span>
        </div>
        <p>{metadata.message}</p>
        <div className="discussion-actions" onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => onEdit(itemId, metadata.key)}><Pencil size={12} /> Edit</button>
          <button type="button" onClick={() => onToggleResolved(itemId, metadata.key)}><CircleCheck size={12} /> Mark {unresolved ? "resolved" : "unresolved"}</button>
          <button type="button" onClick={() => onDelete(itemId, metadata.key)}><Trash2 size={12} /> Discard</button>
        </div>
      </div>
    </div>
  );
}

function commentSummary(message: string) {
  const suggestion = message.match(/```suggestion\s*\n([\s\S]*?)```/);
  return suggestion ? `Suggested change: ${suggestion[1].trim().replace(/\s+/g, " ")}` : message;
}

function suggestionOriginal(comment: GerritComment) {
  const lines = comment.contextLines?.toSorted((a, b) => a.lineNumber - b.lineNumber) ?? [];
  const range = comment.range;
  if (!range) return lines.find((line) => line.lineNumber === comment.line)?.text ?? "";
  const selected = lines.filter((line) => line.lineNumber >= range.startLine && line.lineNumber <= range.endLine);
  if (!selected.length) return "";
  if (range.startLine === range.endLine) return (selected[0]?.text ?? "").slice(range.startCharacter, range.endCharacter);
  return selected.map((line, index) => {
    if (index === 0) return line.text.slice(range.startCharacter);
    if (index === selected.length - 1) return line.text.slice(0, range.endCharacter);
    return line.text;
  }).join("\n");
}

function LinkifiedText({ text, origin, links, returnTo }: { text: string; origin: string; links: GerritCommentLink[]; returnTo?: string }) {
  return linkifyText(text, origin, links).map((part, index) => part.href
    ? <a key={index} href={gerritDiffHref(part.href, origin, returnTo) ?? part.href}>{part.text}</a>
    : part.text);
}

function linkifyCommitMessage(root: ShadowRoot, origin: string, links: GerritCommentLink[], returnTo?: string) {
  if (!root.querySelector("style[data-gerritdiff-links]")) {
    const style = document.createElement("style");
    style.dataset.gerritdiffLinks = "";
    style.textContent = "a[data-gerritdiff-link] { color: var(--accent-strong, var(--diffs-modified-base)); text-decoration: underline; text-underline-offset: 2px; }";
    root.append(style);
  }
  for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest("a[data-gerritdiff-link]")) continue;
      nodes.push(node as Text);
    }
    for (const textNode of nodes) {
      const parts = linkifyText(textNode.data, origin, links);
      if (!parts.some((part) => part.href)) continue;
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        if (!part.href) {
          fragment.append(document.createTextNode(part.text));
          continue;
        }
        const anchor = document.createElement("a");
        anchor.dataset.gerritdiffLink = "";
        anchor.href = gerritDiffHref(part.href, origin, returnTo) ?? part.href;
        anchor.textContent = part.text;
        anchor.addEventListener("click", (event) => event.stopPropagation());
        fragment.append(anchor);
      }
      textNode.replaceWith(fragment);
    }
  }
}

function CommentText({ comment, origin, links, returnTo }: { comment: GerritComment; origin: string; links: GerritCommentLink[]; returnTo?: string }) {
  const { message } = comment;
  const suggestion = message.match(/```suggestion\s*\n([\s\S]*?)```/);
  const renderText = (text: string, key: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return (
      <div className="comment-markup" key={key}>
        {trimmed.split(/\n{2,}/).map((block, index) => block.split("\n").every((line) => line.trimStart().startsWith(">"))
          ? <blockquote key={index}><LinkifiedText text={block.split("\n").map((line) => line.replace(/^\s*>\s?/, "")).join("\n")} origin={origin} links={links} returnTo={returnTo} /></blockquote>
          : <p key={index}><LinkifiedText text={block} origin={origin} links={links} returnTo={returnTo} /></p>)}
      </div>
    );
  };
  if (!suggestion || suggestion.index === undefined) return renderText(message, "message");
  const code = suggestion[1].replace(/\n$/, "");
  const original = suggestionOriginal(comment);
  return (
    <>
      {renderText(message.slice(0, suggestion.index), "before")}
      <div className="gerrit-suggestion">
        <div><strong>Suggested edit</strong><button onClick={() => void navigator.clipboard.writeText(code)}>Copy</button></div>
        <div className="suggestion-diff">
          {original.split("\n").map((line, index) => <div className="suggestion-deletion" key={`old-${index}`}><span>−</span><code>{line}</code></div>)}
          {code.split("\n").map((line, index) => <div className="suggestion-addition" key={`new-${index}`}><span>+</span><code>{line}</code></div>)}
        </div>
      </div>
      {renderText(message.slice(suggestion.index + suggestion[0].length), "after")}
    </>
  );
}

function ExistingDiscussion({ annotation, expanded, localReply, origin, links, returnTo, onToggle, onSaveReply, onDeleteReply }: { annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>; expanded: boolean; localReply?: LocalReply; origin: string; links: GerritCommentLink[]; returnTo?: string; onToggle(key: string): void; onSaveReply(reply: LocalReply): void; onDeleteReply(key: string): void }) {
  const metadata = annotation.metadata;
  const [replyEditor, setReplyEditor] = useState<{ message: string; resolved: boolean } | null>(null);
  if (!metadata || metadata.kind !== "existing") return null;
  const latest = metadata.thread.comments.at(-1);
  const unresolved = latest?.unresolved ?? false;
  const openReply = (message = "", resolved = !unresolved) => setReplyEditor({ message, resolved });
  const saveReply = () => {
    if (!replyEditor) return;
    const trimmed = replyEditor.message.trim();
    if (!trimmed) return;
    onSaveReply({ key: metadata.key, message: trimmed, resolved: replyEditor.resolved });
    setReplyEditor(null);
  };
  if (!expanded) {
    return (
      <div className={`comment-card existing-discussion existing-discussion-collapsed ${unresolved ? "thread-unresolved" : "thread-resolved"}`}>
        <button type="button" className="collapsed-thread-button" onClick={(event) => { event.stopPropagation(); onToggle(metadata.key); }} aria-expanded="false">
          <MessageSquare size={14} />
          <span className="collapsed-thread-copy">
            <span><strong>{latest?.author.name ?? "Review discussion"}</strong><small>{metadata.thread.comments.length} comment{metadata.thread.comments.length === 1 ? "" : "s"}</small></span>
            <span>{commentSummary(latest?.message ?? "")}</span>
          </span>
          {localReply && <span className="collapsed-thread-pending">Pending</span>}
          <span className="thread-state">{unresolved ? "Unresolved" : "Resolved"}</span>
          <ChevronDown size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className={`comment-card existing-discussion ${unresolved ? "thread-unresolved" : "thread-resolved"}`}>
      <button type="button" className="existing-thread-head" onClick={(event) => { event.stopPropagation(); onToggle(metadata.key); }} aria-expanded="true">
        <span className="existing-thread-heading">
          <span className="existing-thread-path" title={metadata.thread.path}>{metadata.thread.path === "/PATCHSET_LEVEL" ? "Patchset-level comment" : metadata.thread.path}</span>
          <strong>{metadata.thread.comments.length === 1 ? "Review comment" : `${metadata.thread.comments.length} comment discussion`}</strong>
          {metadata.textRange
            ? <span className="comment-text-range">{textRangeLabel(metadata.textRange)}</span>
            : threadIsFileLevel(metadata.thread) ? <span className="comment-text-range">Whole file</span> : null}
        </span>
        <span className="thread-state">{unresolved ? "Unresolved" : "Resolved"}</span>
        <ChevronDown className="expanded-thread-chevron" size={14} />
      </button>
      {metadata.thread.comments.map((comment) => (
        <div className={`existing-comment${comment.id.startsWith("local-reply-") ? " local-reply" : ""}`} key={comment.id}>
          <span className="comment-avatar" style={comment.author.avatarUrl ? { backgroundImage: `url(${comment.author.avatarUrl})` } : undefined}>
            {comment.author.avatarUrl ? null : comment.author.name.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <div className="existing-comment-meta"><strong>{comment.author.name}</strong><span>{comment.id.startsWith("local-reply-") ? "Local reply" : `Patchset ${comment.patchSet}`}</span></div>
            <CommentText comment={comment} origin={origin} links={links} returnTo={returnTo} />
          </div>
        </div>
      ))}
      {localReply && replyEditor === null && (
        <div className={`pending-reply ${localReply.resolved ? "pending-resolves" : "pending-unresolved"}`}>
          <div><strong>Reply queued for review</strong><span className={`pending-resolution ${localReply.resolved ? "resolves" : "unresolved"}`}>{localReply.resolved ? <CircleCheck size={11} /> : <MessageSquare size={11} />}{localReply.resolved ? "Resolves discussion" : "Keeps discussion unresolved"}</span></div>
          <p>{localReply.message}</p>
          <div><button onClick={() => setReplyEditor({ message: localReply.message, resolved: localReply.resolved })}>Edit</button><button onClick={() => onDeleteReply(metadata.key)}>Discard</button></div>
        </div>
      )}
      <div className="discussion-actions">
        <button onClick={() => openReply(localReply?.message ?? "", localReply?.resolved ?? !unresolved)}><Reply size={12} /> Reply</button>
        <button onClick={() => openReply(`${(latest?.message ?? "").split("\n").map((line) => `> ${line}`).join("\n")}\n\n`, localReply?.resolved ?? !unresolved)}><Quote size={12} /> Quote</button>
        <button onClick={() => onSaveReply({ key: metadata.key, message: "Ack", resolved: true })}><Check size={12} /> Ack</button>
        <button onClick={() => onSaveReply({ key: metadata.key, message: "Done", resolved: true })}><CircleCheck size={12} /> Done</button>
      </div>
      {replyEditor !== null && (
        <form className="discussion-reply" onSubmit={(event) => { event.preventDefault(); saveReply(); }}>
          <textarea autoFocus rows={3} value={replyEditor.message} onChange={(event) => setReplyEditor((current) => current ? { ...current, message: event.target.value } : current)} placeholder="Write a reply…" />
          <div className="reply-options">
            <button className={`resolution-toggle ${replyEditor.resolved ? "is-resolved" : "is-unresolved"}`} type="button" aria-pressed={replyEditor.resolved} onClick={() => setReplyEditor((current) => current ? { ...current, resolved: !current.resolved } : current)}>
              <CircleCheck size={12} /> {replyEditor.resolved ? "Resolved" : "Unresolved"}
            </button>
            <span>Toggle whether this discussion still needs action.</span>
          </div>
          <div><span>This reply will be included when you publish the review.</span><button type="button" onClick={() => setReplyEditor(null)}>Cancel</button><button type="submit" disabled={!replyEditor.message.trim()}>Save reply</button></div>
        </form>
      )}
    </div>
  );
}

function DiscussionSidebar({ threads, revisionNumber, onSelect }: { threads: DiscussionThread[]; revisionNumber: number; onSelect(thread: DiscussionThread): void }) {
  if (!threads.length) return <div className="discussion-empty"><MessageSquare size={20} /><strong>No discussion yet</strong><span>Published Gerrit comments will appear here.</span></div>;
  const current = threads.filter((thread) => threadBelongsToPatchset(thread, revisionNumber));
  const other = threads.filter((thread) => !threadBelongsToPatchset(thread, revisionNumber));
  const renderThread = (thread: DiscussionThread, historical: boolean) => {
    const latest = thread.comments.at(-1);
    const patchset = threadPatchset(thread) ?? latest?.patchSet ?? revisionNumber;
    return (
      <button className={latest?.unresolved ? "sidebar-thread-unresolved" : "sidebar-thread-resolved"} key={thread.key} onClick={() => onSelect(thread)}>
        <span className="discussion-path">{thread.path === "/PATCHSET_LEVEL" ? "Patchset-level comment" : thread.path}{threadIsFileLevel(thread) ? " · whole file" : ""}</span>
        <span className="discussion-author"><strong>{thread.comments[0]?.author.name}</strong><i>{latest?.unresolved ? "Unresolved" : "Resolved"}</i></span>
        <p>{commentSummary(thread.comments[0]?.message ?? "")}</p>
        <span className="discussion-meta">{thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"} · Patchset {patchset}{historical ? " · Switches patchset" : ""}</span>
      </button>
    );
  };
  return (
    <div className="discussion-sidebar">
      <div className="discussion-group-title"><span>Patchset {revisionNumber}</span><b>{current.length}</b></div>
      {current.map((thread) => renderThread(thread, false))}
      {other.length > 0 && <div className="discussion-group-title"><span>Other patchsets</span><b>{other.length}</b></div>}
      {other.toSorted((a, b) => (b.comments.at(-1)?.patchSet ?? 0) - (a.comments.at(-1)?.patchSet ?? 0)).map((thread) => renderThread(thread, true))}
    </div>
  );
}

function RelationChainPanel({ relations }: { relations: RelatedChange[] }) {
  return (
    <div className="relation-chain-list">
      {relations.map((relation, index) => {
        const label = relation.changeNumber ? `Change ${relation.changeNumber}` : relation.commit.slice(0, 12);
        const revision = relation.revisionNumber ? `PS${relation.revisionNumber}` : relation.commit.slice(0, 8);
        const content = (
          <>
            <span className="relation-node" aria-hidden="true"><i /></span>
            <span className="relation-copy">
              <span className="relation-heading">
                <strong>{label}</strong>
                <code>{revision}</code>
                {relation.revisionNumber && relation.currentRevisionNumber && relation.revisionNumber !== relation.currentRevisionNumber && <em>outdated</em>}
              </span>
              <span className="relation-subject">{relation.subject}</span>
              <span className="relation-meta">{relation.project}{relation.status ? ` · ${relation.status.toLowerCase()}` : ""}</span>
            </span>
          </>
        );
        return relation.isCurrent || !relation.sourceUrl ? (
          <div key={`${relation.commit}:${index}`} className={`relation-item${relation.isCurrent ? " is-current" : ""}`} aria-current={relation.isCurrent ? "page" : undefined}>{content}</div>
        ) : (
          <a key={`${relation.commit}:${index}`} className="relation-item" href={`/?url=${encodeURIComponent(relation.sourceUrl)}`}>{content}</a>
        );
      })}
    </div>
  );
}

function CollapseButton({ collapsed, disabled, onToggle }: { collapsed?: boolean; disabled: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className="pierre-collapse"
      disabled={disabled}
      aria-label={collapsed ? "Expand diff" : "Collapse diff"}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggle(); }}
    >
      <ChevronDown className={collapsed ? "closed" : ""} size={15} />
    </button>
  );
}

function SidebarDiffStats({ files, additions, deletions }: { files: FileDiffMetadata[]; additions: number; deletions: number }) {
  const [expanded, setExpanded] = useState(true);
  const lines = useMemo(() => files.reduce((total, file) => total + file.unifiedLineCount, 0), [files]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      event.preventDefault();
      setExpanded((current) => !current);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const rows = [
    { label: "Files", value: files.length, className: "" },
    { label: "Additions", value: additions, className: "is-addition" },
    { label: "Deletions", value: deletions, className: "is-deletion" },
    { label: "Lines", value: lines, className: "" },
  ];

  return (
    <div className={`sidebar-diff-stats${expanded ? " is-expanded" : ""}`}>
      <button type="button" className="sidebar-diff-stats-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span className="sidebar-diff-stats-icon" aria-hidden="true">±</span>
        <span>Diff stats</span>
        <small>F2</small>
        <ChevronDown size={12} />
      </button>
      {expanded && (
        <div className="sidebar-diff-stats-rows">
          {rows.map((row) => (
            <div className="sidebar-diff-stat" key={row.label}>
              <span>{row.label}</span>
              <strong className={row.className}>{row.value.toLocaleString("en-US")}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewFileTree({
  files,
  onSelect,
}: {
  files: FileDiffMetadata[];
  onSelect(itemId: string): void;
}) {
  const paths = useMemo(() => files.map((file) => file.name), [files]);
  const pathToId = useMemo(() => new Map(files.map((file, index) => [file.name, `file-${index}`])), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(() => files.map((file) => ({ path: file.name, status: gitStatusFor(file) })), [files]);
  const handleSelection = useCallback((selectedPaths: readonly string[]) => {
    const id = selectedPaths.length === 1 ? pathToId.get(selectedPaths[0]) : undefined;
    if (id) onSelect(id);
  }, [onSelect, pathToId]);
  const { model } = useFileTree({
    paths,
    gitStatus,
    icons: { set: "standard", colored: false },
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialVisibleRowCount: 30,
    itemHeight: 25,
    onSelectionChange: handleSelection,
    search: true,
    stickyFolders: true,
    unsafeCSS: `
      [data-file-tree-search-container] { margin: 8px; }
      [data-file-tree-virtualized-scroll='true'] { padding-inline: 4px; }
      [data-item-contains-git-change='true'] > [data-item-section='git'] { display: none; }
    `,
  });

  return <FileTree model={model} className="pierre-tree" />;
}

export function ChangeReview({ data, theme, initialThreadId, dashboardReturnTo, comparisonLoading = false, onPatchsetChange, onBaseChange }: { data: ChangeData; theme: GerritDiffTheme; initialThreadId?: string; dashboardReturnTo?: string; comparisonLoading?: boolean; onPatchsetChange(patchset: number, threadId?: string): void; onBaseChange(base?: number): void }) {
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const codeViewContainerRef = useRef<HTMLDivElement | null>(null);
  const activeDraftRef = useRef<ActiveDraft | null>(null);
  const nextCommentRef = useRef(1);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [movedCodeOpen, setMovedCodeOpen] = useState(false);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [codeTextSelection, setCodeTextSelection] = useState<CodeTextSelection | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [ignoreIndentation, setIgnoreIndentation] = useState(true);
  const [tabSize, setTabSize] = useState(2);
  const [sidebarMode, setSidebarMode] = useState<"changed" | "repository" | "discussion">("changed");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reviewersExpanded, setReviewersExpanded] = useState(false);
  const [knownPath, setKnownPath] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingItems, setLoadingItems] = useState<ReadonlySet<string>>(() => new Set());
  const [localReplies, setLocalReplies] = useState<LocalReply[]>([]);
  const [localReviewComments, setLocalReviewComments] = useState<LocalReviewComment[]>([]);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const activeThreadKey = rightPanel?.kind === "discussion" ? rightPanel.threadKey : null;
  const commentScope = rightPanel?.kind === "scope" ? rightPanel.path : null;
  const relationPanelOpen = rightPanel?.kind === "relation";
  const openedInitialThreadRef = useRef<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<{ key: string | null; message: string; resolved: boolean } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [sshUser, setSshUser] = useState("");
  const [sshHost, setSshHost] = useState(data.sshHost);
  const [sshPort, setSshPort] = useState("29418");
  const [reviewMessage, setReviewMessage] = useState("");
  const [codeReview, setCodeReview] = useState("");
  const [copied, setCopied] = useState(false);
  const commitMessageContent = data.commitMessage;
  const sourceOrigin = new URL(data.sourceUrl).origin;
  // The input URL may mean "current". Snapshot requests must follow the displayed
  // patchset, not a separately cached (or newly uploaded) current revision.
  const revisionSourceUrl = patchsetUrl(data.sourceUrl, data.changeNumber, data.revisionNumber);

  const files = useMemo(() => {
    if (!data.comparisonFiles) return parsePatchFiles(data.patch, `${data.host}-${data.changeNumber}-${data.revisionNumber}`, true).flatMap((parsed) => parsed.files);
    return data.comparisonFiles.flatMap((file, index) => {
      if (file.binary) {
        const oldName = file.previousName ?? file.name;
        const patch = `diff --git a/${oldName} b/${file.name}\nBinary files a/${oldName} and b/${file.name} differ\n`;
        return parsePatchFiles(patch, `${data.revision}:compare:${data.baseRevisionNumber}:binary:${index}`, true).flatMap((parsed) => parsed.files);
      }
      const fileDiff = parseDiffFromFile(
        { name: file.previousName ?? file.name, contents: file.baseContent ?? "", cacheKey: `${data.baseRevisionNumber}:${file.previousName ?? file.name}` },
        { name: file.name, contents: file.targetContent ?? "", cacheKey: `${data.revision}:${file.name}` },
        undefined,
        true,
      );
      fileDiff.type = file.status === "A" ? "new" : file.status === "D" ? "deleted" : file.status === "R" ? "rename-changed" : file.status === "C" ? "rename-changed" : "change";
      fileDiff.prevName = file.previousName;
      return [fileDiff];
    });
  }, [data.baseRevisionNumber, data.changeNumber, data.comparisonFiles, data.host, data.patch, data.revision, data.revisionNumber]);
  // Gerrit anchors /COMMIT_MSG comments in its magic file, which prefixes the message with
  // generated header lines. The viewer shows the bare message, so shift into that frame here
  // (commentInput shifts back when publishing).
  const viewComments = useMemo(
    () => data.comments.map((comment) => comment.path === "/COMMIT_MSG" ? shiftCommitMessageComment(comment, -data.commitMessageLineOffset) : comment),
    [data.comments, data.commitMessageLineOffset],
  );
  const discussionThreads = useMemo(() => buildDiscussionThreads(viewComments), [viewComments]);
  const currentDiscussionCount = discussionThreads.filter((thread) => threadBelongsToPatchset(thread, data.revisionNumber)).length;
  const patchsetLevelThreads = discussionThreads.filter((thread) => thread.path === "/PATCHSET_LEVEL" && threadPatchset(thread) === data.revisionNumber);
  const unresolvedPatchsetDiscussionCount = patchsetLevelThreads.filter((thread) => thread.comments.at(-1)?.unresolved).length;
  const fileLevelThreads = useMemo(() => {
    const byPath = new Map<string, DiscussionThread[]>();
    for (const thread of discussionThreads) {
      if (!threadIsFileLevel(thread) || !threadBelongsToPatchset(thread, data.revisionNumber)) continue;
      byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
    }
    return byPath;
  }, [data.revisionNumber, discussionThreads]);
  const initialItems = useMemo<CodeViewItem<CommentMetadata>[]>(
    () => [
      ...(commitMessageContent ? [{
        id: "commit-message",
        type: "file" as const,
        file: { name: "Commit message", contents: commitMessageContent, cacheKey: `${data.revision}:commit-message` },
        annotations: discussionThreads.flatMap((thread): LineAnnotation<CommentMetadata>[] => {
          const anchor = threadAnchor(thread, data.revisionNumber);
          if (!anchor || anchor.path !== "/COMMIT_MSG") return [];
          const range = commentRange(anchor);
          return [{
            lineNumber: range.end,
            metadata: { kind: "existing", key: `gerrit:${thread.key}`, range, textRange: commentTextRange(anchor), thread },
          }];
        }),
      }] : []),
      ...files.map((fileDiff, index) => {
        const annotations: DiffLineAnnotation<CommentMetadata>[] = [];
        for (const thread of discussionThreads) {
          const anchor = threadAnchor(thread, data.revisionNumber);
          if (!anchor || anchor.path !== fileDiff.name) continue;
          const range = commentRange(anchor);
          annotations.push({
            side: range.side ?? "additions",
            lineNumber: range.end,
            metadata: { kind: "existing", key: `gerrit:${thread.key}`, range, textRange: commentTextRange(anchor), thread },
          });
        }
        return { id: `file-${index}`, type: "diff" as const, fileDiff, annotations };
      }),
    ],
    [commitMessageContent, data.revision, data.revisionNumber, discussionThreads, files],
  );
  const pathToChangedId = useMemo(
    () => new Map(files.map((file, index) => [file.name, `file-${index}`])),
    [files],
  );
  const movedCodeFiles = useMemo(() => {
    const collect = (side: "old" | "new") => {
      const options = new Map<string, FileSnapshotOption>();
      files.forEach((file, index) => {
        if ((side === "old" && file.type === "new") || (side === "new" && file.type === "deleted")) return;
        const comparison = data.comparisonFiles?.[index];
        const path = side === "old" ? file.prevName ?? file.name : file.name;
        const content = side === "old" ? comparison?.baseContent : comparison?.targetContent;
        const score = file.hunks.reduce((total, hunk) => total + (side === "old" ? hunk.deletionLines : hunk.additionLines), 0);
        const current = options.get(path);
        options.set(path, { path, content: current?.content ?? content, score: Math.max(current?.score ?? 0, score) });
      });
      return [...options.values()].toSorted((left, right) => left.path.localeCompare(right.path));
    };
    return { old: collect("old"), new: collect("new") };
  }, [data.comparisonFiles, files]);
  const searchMatches = useMemo<SearchMatch[]>(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    const matches: SearchMatch[] = [];
    for (const item of initialItems) {
      if (item.type === "file") {
        item.file.contents.split(/\r?\n/).forEach((line, index) => {
          if (line.toLocaleLowerCase().includes(query)) matches.push({ itemId: item.id, lineNumber: index + 1 });
        });
        continue;
      }
      item.fileDiff.deletionLines.forEach((line, index) => {
        if (line.toLocaleLowerCase().includes(query)) matches.push({ itemId: item.id, lineNumber: index + 1, side: "deletions" });
      });
      item.fileDiff.additionLines.forEach((line, index) => {
        if (line.toLocaleLowerCase().includes(query)) matches.push({ itemId: item.id, lineNumber: index + 1, side: "additions" });
      });
    }
    return matches;
  }, [initialItems, searchQuery]);

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (movedCodeOpen || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, [movedCodeOpen]);

  useEffect(() => {
    const settings = readProjectUiSettings(data.host, data.project);
    const frame = requestAnimationFrame(() => {
      setTabSize(settings.tabSize === 4 || settings.tabSize === 8 ? settings.tabSize : 2);
      setShowWhitespace(settings.showWhitespace ?? false);
      setIgnoreIndentation(settings.ignoreIndentation ?? true);
      setSidebarCollapsed(settings.sidebarCollapsed ?? false);
      setReviewersExpanded(readReviewersExpanded());
      if (settings.sidebarMode === "repository" || settings.sidebarMode === "discussion") setSidebarMode(settings.sidebarMode);
      else setSidebarMode("changed");
      setRightPanel(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [data.host, data.project]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = codeViewContainerRef.current;
      if (!container) return;
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [data.baseRevisionNumber, data.revision]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateForViewport = (matches: boolean) => {
      const preferred = readProjectUiSettings(data.host, data.project).diffStyle;
      setDiffStyle(matches ? "unified" : preferred === "unified" ? "unified" : "split");
    };
    const handleChange = (event: MediaQueryListEvent) => updateForViewport(event.matches);
    updateForViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [data.host, data.project]);

  const refreshSearchHighlights = useCallback(() => {
    // SAFETY: CSS.highlights is a progressive browser API absent from the current TypeScript DOM declarations.
    const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }).highlights;
    // SAFETY: window.Highlight is checked before construction because the CSS Highlight API is optional.
    const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const query = searchQuery.trim();
    const activeMatch = searchMatches[searchIndex];
    if (!registry || !HighlightConstructor || !query || !activeMatch) {
      registry?.delete(SEARCH_HIGHLIGHT_NAME);
      registry?.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
      return;
    }
    const ranges: Range[] = [];
    const activeRanges: Range[] = [];
    for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
      const root = rendered.element.shadowRoot;
      if (!root) continue;
      for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
        const lineNumber = Number(line.dataset.line);
        const side = rendered.type === "diff" ? selectionSide(line) : undefined;
        if (!searchMatches.some((match) => match.itemId === rendered.id && match.lineNumber === lineNumber && match.side === side)) continue;
        const lineRanges = textMatchRanges(line, query);
        if (rendered.id === activeMatch.itemId && lineNumber === activeMatch.lineNumber && side === activeMatch.side) activeRanges.push(...lineRanges);
        else ranges.push(...lineRanges);
      }
    }
    if (ranges.length) registry.set(SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...ranges));
    else registry.delete(SEARCH_HIGHLIGHT_NAME);
    if (activeRanges.length) registry.set(ACTIVE_SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...activeRanges));
    else registry.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
  }, [searchIndex, searchMatches, searchQuery]);

  useEffect(() => {
    if (!searchOpen || !searchMatches.length) return;
    const match = searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    viewerRef.current?.scrollTo({ type: "line", id: match.itemId, lineNumber: match.lineNumber, side: match.side, align: "center" });
    const frame = requestAnimationFrame(() => requestAnimationFrame(refreshSearchHighlights));
    return () => cancelAnimationFrame(frame);
  }, [refreshSearchHighlights, searchIndex, searchMatches, searchOpen]);

  useEffect(() => {
    if (searchOpen) refreshSearchHighlights();
    else {
      // SAFETY: CSS.highlights is a progressive browser API absent from the current TypeScript DOM declarations.
      const registry = (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights;
      registry?.delete(SEARCH_HIGHLIGHT_NAME);
      registry?.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
    }
  }, [refreshSearchHighlights, searchOpen]);

  const refreshCommentHighlights = useCallback(() => {
    // SAFETY: CSS.highlights is a progressive browser API absent from the current TypeScript DOM declarations.
    const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }).highlights;
    // SAFETY: window.Highlight is checked before construction because the CSS Highlight API is optional.
    const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !HighlightConstructor) return;
    const ranges: Range[] = [];
    for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
      const root = rendered.element.shadowRoot;
      if (!root) continue;
      for (const annotation of rendered.item.annotations ?? []) {
        const metadata = annotation.metadata;
        if (!metadata?.textRange) continue;
        const side = metadata.range.endSide ?? metadata.range.side ?? "additions";
        ranges.push(...highlightedTextRanges(root, metadata.textRange, side, rendered.type === "diff"));
      }
    }
    if (ranges.length) registry.set(COMMENT_HIGHLIGHT_NAME, new HighlightConstructor(...ranges));
    else registry.delete(COMMENT_HIGHLIGHT_NAME);
  }, []);

  const captureCodeTextSelection = useCallback(() => {
    const renderedItems = viewerRef.current?.getInstance()?.getRenderedItems() ?? [];
    for (const rendered of renderedItems) {
      const root = rendered.element.shadowRoot;
      if (!root) continue;
      const shadowSelection = (root as ShadowRoot & { getSelection?(): Selection | null }).getSelection?.();
      const selections = [shadowSelection, document.getSelection()];
      for (const selection of selections) {
        if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) continue;
        if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) continue;
        const domRange = selection.getRangeAt(0);
        const startLine = lineElementFor(domRange.startContainer);
        const endLine = lineElementFor(domRange.endContainer);
        if (!startLine || !endLine) continue;
        const side = rendered.type === "diff" ? selectionSide(startLine) : "additions";
        const endSide = rendered.type === "diff" ? selectionSide(endLine) : "additions";
        if (side !== endSide) continue;
        const start = Number(startLine.dataset.line);
        const end = Number(endLine.dataset.line);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) continue;
        const startCharacter = characterOffset(startLine, domRange.startContainer, domRange.startOffset);
        const endCharacter = characterOffset(endLine, domRange.endContainer, domRange.endOffset);
        if (start === end && startCharacter === endCharacter) continue;
        const rect = domRange.getBoundingClientRect();
        const range = { start, end, side, endSide } satisfies SelectedLineRange;
        const popupWidth = 120;
        const popupHeight = 30;
        const popupGap = 6;
        const topAbove = rect.top - popupHeight - popupGap;
        const top = topAbove >= 8
          ? topAbove
          : Math.min(window.innerHeight - popupHeight - 8, rect.bottom + popupGap);
        setCodeTextSelection({
          itemId: rendered.id,
          range,
          textRange: {
            start_line: start,
            start_character: startCharacter,
            end_line: end,
            end_character: endCharacter,
          },
          top: Math.max(8, top),
          left: Math.max(8, Math.min(window.innerWidth - popupWidth - 8, rect.left + rect.width / 2 - popupWidth / 2)),
        });
        return;
      }
    }
    setCodeTextSelection(null);
  }, []);

  useEffect(() => {
    const container = codeViewContainerRef.current;
    if (!container) return;
    const handlePointerUp = () => window.setTimeout(captureCodeTextSelection, 0);
    const clearTextSelection = () => setCodeTextSelection(null);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("scroll", clearTextSelection, { passive: true });
    return () => {
      container.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("scroll", clearTextSelection);
    };
  }, [captureCodeTextSelection]);

  useEffect(() => {
    const container = codeViewContainerRef.current;
    if (!container) return;
    const refreshRenderedContent = () => {
      refreshCommentHighlights();
      for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
        if (rendered.id === "commit-message" && rendered.element.shadowRoot) linkifyCommitMessage(rendered.element.shadowRoot, sourceOrigin, data.commentLinks, dashboardReturnTo);
      }
    };
    let frame = requestAnimationFrame(refreshRenderedContent);
    const observedRoots = new WeakSet<ShadowRoot>();
    const shadowObservers: MutationObserver[] = [];
    const scheduleRefresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshRenderedContent);
    };
    const observeShadowRoots = () => {
      for (const host of container.querySelectorAll<HTMLElement>("diffs-container")) {
        const root = host.shadowRoot;
        if (!root || observedRoots.has(root)) continue;
        observedRoots.add(root);
        const observer = new MutationObserver(scheduleRefresh);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        shadowObservers.push(observer);
      }
    };
    const containerObserver = new MutationObserver(() => {
      observeShadowRoots();
      scheduleRefresh();
    });
    containerObserver.observe(container, { childList: true, subtree: true });
    observeShadowRoots();
    return () => {
      containerObserver.disconnect();
      for (const observer of shadowObservers) observer.disconnect();
      cancelAnimationFrame(frame);
      // SAFETY: CSS.highlights is a progressive browser API absent from the current TypeScript DOM declarations.
      (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights?.delete(COMMENT_HIGHLIGHT_NAME);
    };
  }, [dashboardReturnTo, data.commentLinks, refreshCommentHighlights, sourceOrigin]);

  const updateCommentItem = useCallback((itemId: string, update: (item: CodeViewItem<CommentMetadata>) => boolean) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (!viewer || !item || !update(item)) return undefined;
    item.version = nextVersion(item);
    return viewer.updateItem(item) ? item : undefined;
  }, []);

  const removeComment = useCallback((itemId: string, key: string) => {
    let removedSaved = false;
    updateCommentItem(itemId, (item) => {
      const target = item.annotations?.find((annotation) => annotation.metadata?.key === key);
      removedSaved = target?.metadata?.kind === "saved";
      if (item.type === "diff") {
        const annotations = item.annotations?.filter((annotation) => annotation.metadata?.key !== key) ?? [];
        if (annotations.length === (item.annotations?.length ?? 0)) return false;
        item.annotations = annotations;
      } else {
        const annotations = item.annotations?.filter((annotation) => annotation.metadata?.key !== key) ?? [];
        if (annotations.length === (item.annotations?.length ?? 0)) return false;
        item.annotations = annotations;
      }
      return true;
    });
    if (removedSaved) {
      setLocalReviewComments((comments) => comments.filter((comment) => comment.key !== key));
    }
    if (activeDraftRef.current?.key === key) activeDraftRef.current = null;
    setSelectedLines(null);
  }, [updateCommentItem]);

  const saveComment = useCallback((itemId: string, key: string, message: string, unresolved: boolean) => {
    const updated = updateCommentItem(itemId, (item) => {
      if (!item.annotations) return false;
      item.annotations = item.annotations.map((annotation) =>
        annotation.metadata?.key === key
          ? { ...annotation, metadata: { ...annotation.metadata, kind: "saved" as const, author: "You", message, unresolved } }
          : annotation,
      ) as typeof item.annotations;
      return true;
    });
    if (updated) {
      const saved = updated.annotations?.find((annotation) => annotation.metadata?.key === key)?.metadata;
      if (saved?.kind === "saved") {
        setLocalReviewComments((comments) => [
          ...comments.filter((comment) => comment.key !== key),
          { key, path: updated.type === "diff" ? updated.fileDiff.name : updated.id === "commit-message" ? "/COMMIT_MSG" : updated.file.name, message, range: saved.range, textRange: saved.textRange, unresolved },
        ]);
      }
      activeDraftRef.current = null;
      setSelectedLines(null);
    }
  }, [updateCommentItem]);

  const editComment = useCallback((itemId: string, key: string) => {
    const updated = updateCommentItem(itemId, (item) => {
      const target = item.annotations?.find((annotation) => annotation.metadata?.key === key)?.metadata;
      if (target?.kind !== "saved") return false;
      item.annotations = item.annotations?.map((annotation) =>
        annotation.metadata?.key === key
          ? { ...annotation, metadata: { kind: "draft" as const, key, message: target.message, range: target.range, textRange: target.textRange, unresolved: target.unresolved } }
          : annotation,
      ) as typeof item.annotations;
      return true;
    });
    if (updated) activeDraftRef.current = { itemId, key };
  }, [updateCommentItem]);

  const toggleCommentResolved = useCallback((itemId: string, key: string) => {
    let next: boolean | undefined;
    updateCommentItem(itemId, (item) => {
      const target = item.annotations?.find((annotation) => annotation.metadata?.key === key)?.metadata;
      if (target?.kind !== "saved") return false;
      next = !(target.unresolved ?? true);
      item.annotations = item.annotations?.map((annotation) =>
        annotation.metadata?.key === key
          ? { ...annotation, metadata: { ...target, unresolved: next } }
          : annotation,
      ) as typeof item.annotations;
      return true;
    });
    if (next !== undefined) {
      setLocalReviewComments((comments) => comments.map((comment) => comment.key === key ? { ...comment, unresolved: next } : comment));
    }
  }, [updateCommentItem]);

  const createDraft = useCallback((range: SelectedLineRange, itemId: string, textRange?: GerritTextRange) => {
    const item = viewerRef.current?.getItem(itemId);
    const side = range.endSide ?? range.side ?? (item?.type === "file" ? "additions" : undefined);
    if (!side) return;
    const key = `draft-${nextCommentRef.current++}`;
    const previous = activeDraftRef.current;
    if (previous && previous.itemId !== itemId) removeComment(previous.itemId, previous.key);
    const updated = updateCommentItem(itemId, (item) => {
      if (item.type === "diff") {
        const annotation: DiffLineAnnotation<CommentMetadata> = {
          side,
          lineNumber: range.end,
          metadata: { kind: "draft", key, message: "", range, textRange },
        };
        item.annotations = [...(item.annotations ?? []).filter((entry) => entry.metadata?.kind !== "draft"), annotation];
      } else {
        const annotation: LineAnnotation<CommentMetadata> = {
          lineNumber: range.end,
          metadata: { kind: "draft", key, message: "", range: { ...range, side: "additions", endSide: "additions" }, textRange },
        };
        item.annotations = [...(item.annotations ?? []).filter((entry) => entry.metadata?.kind !== "draft"), annotation];
      }
      return true;
    });
    if (updated) {
      activeDraftRef.current = { itemId, key };
      if (textRange) setSelectedLines(null);
      setCodeTextSelection(null);
    }
  }, [removeComment, updateCommentItem]);

  const commentOnTextSelection = useCallback(() => {
    if (!codeTextSelection) return;
    createDraft(codeTextSelection.range, codeTextSelection.itemId, codeTextSelection.textRange);
  }, [codeTextSelection, createDraft]);

  useEffect(() => {
    const handleKeyboardComment = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || !codeTextSelection) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
      event.preventDefault();
      commentOnTextSelection();
    };
    window.addEventListener("keydown", handleKeyboardComment);
    return () => window.removeEventListener("keydown", handleKeyboardComment);
  }, [codeTextSelection, commentOnTextSelection]);

  const toggleCollapsed = useCallback((itemId: string) => {
    updateCommentItem(itemId, (item) => { item.collapsed = !item.collapsed; return true; });
  }, [updateCommentItem]);

  const toggleCommentSelection = useCallback((selection: CodeViewLineSelection | null) => {
    if (!selection) {
      setSelectedLines(null);
      return;
    }
    setSelectedLines((current) => current?.id === selection.id && areSelectionsEqual(current.range, selection.range) ? null : selection);
  }, []);

  useEffect(() => {
    for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
      const root = rendered.element.shadowRoot;
      if (root) updateWhitespaceMarkers(root, showWhitespace);
    }
  }, [showWhitespace]);

  const options = useMemo<CodeViewOptions<CommentMetadata>>(() => ({
    ...createCodeViewDiffOptions<CommentMetadata>({
      theme,
      diffStyle,
      tabSize,
      unsafeCSS: `
        ::highlight(${COMMENT_HIGHLIGHT_NAME}) { background-color: rgba(231, 177, 54, .38); text-decoration: underline 1px rgba(245, 198, 83, .9); text-underline-offset: 2px; }
        ::highlight(${SEARCH_HIGHLIGHT_NAME}) { color: #17131f; background-color: rgba(255, 214, 72, .72); }
        ::highlight(${ACTIVE_SEARCH_HIGHLIGHT_NAME}) { color: #17131f; background-color: #ff9f43; text-decoration: underline 2px #7a3d00; text-underline-offset: 2px; }
      `,
    }),
    layout: { paddingTop: 0, gap: 1, paddingBottom: 0 },
    lineHoverHighlight: "number",
    enableLineSelection: true,
    enableGutterUtility: true,
    stickyHeaders: true,
    onPostRender(node) {
      updateWhitespaceMarkers(node, showWhitespace);
      requestAnimationFrame(refreshSearchHighlights);
    },
    onGutterUtilityClick(range, context) {
      createDraft(range, context.item.id);
    },
  }), [createDraft, diffStyle, refreshSearchHighlights, showWhitespace, tabSize, theme]);

  const saveLocalReply = useCallback((reply: LocalReply) => {
    setLocalReplies((current) => [...current.filter((entry) => entry.key !== reply.key), reply]);
  }, []);

  const deleteLocalReply = useCallback((key: string) => {
    setLocalReplies((current) => current.filter((entry) => entry.key !== key));
  }, []);

  const updateThreadUrl = useCallback((threadId?: string) => {
    const params = new URLSearchParams(window.location.search);
    if (threadId) params.set("thread", threadId);
    else params.delete("thread");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, []);

  const toggleActiveDiscussion = useCallback((key: string) => {
    if (activeThreadKey === key) {
      setRightPanel(null);
      updateThreadUrl();
      return;
    }
    setRightPanel({ kind: "discussion", threadKey: key });
    const thread = discussionThreads.find((candidate) => `gerrit:${candidate.key}` === key);
    updateThreadUrl(thread?.key);
  }, [activeThreadKey, discussionThreads, updateThreadUrl]);

  const localReplyComments = useMemo<LocalReviewComment[]>(() => localReplies.flatMap((reply) => {
    const thread = discussionThreads.find((candidate) => `gerrit:${candidate.key}` === reply.key);
    const anchor = thread ? threadAnchor(thread, data.revisionNumber) ?? thread.comments[0] : undefined;
    const latestPublished = thread?.comments.findLast((comment) => !comment.id.startsWith("local-reply-"));
    if (!anchor || !latestPublished) return [];
    return [{
      key: reply.key,
      path: anchor.path,
      message: reply.message,
      range: commentRange(anchor),
      textRange: commentTextRange(anchor),
      gerritLine: anchor.gerritLine,
      gerritRange: anchor.gerritRange ? {
        start_line: anchor.gerritRange.startLine,
        start_character: anchor.gerritRange.startCharacter,
        end_line: anchor.gerritRange.endLine,
        end_character: anchor.gerritRange.endCharacter,
      } : undefined,
      parent: anchor.parent,
      inReplyTo: latestPublished.id,
      unresolved: !reply.resolved,
    }];
  }), [data.revisionNumber, discussionThreads, localReplies]);

  const localCommentCount = localReviewComments.length + localReplies.length;
  const localPatchsetComments = useMemo(() => localReviewComments.filter((comment) => comment.path === "/PATCHSET_LEVEL"), [localReviewComments]);
  const localFileLevelComments = useMemo(() => {
    const byPath = new Map<string, LocalReviewComment[]>();
    for (const comment of localReviewComments) {
      if (comment.path === "/PATCHSET_LEVEL" || comment.range.end > 0) continue;
      byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), comment]);
    }
    return byPath;
  }, [localReviewComments]);

  const scopeThreads = useMemo(
    () => commentScope
      ? commentScope === "/PATCHSET_LEVEL" ? patchsetLevelThreads : fileLevelThreads.get(commentScope) ?? []
      : [],
    [commentScope, fileLevelThreads, patchsetLevelThreads],
  );
  const scopeDrafts = useMemo(
    () => commentScope
      ? commentScope === "/PATCHSET_LEVEL" ? localPatchsetComments : localFileLevelComments.get(commentScope) ?? []
      : [],
    [commentScope, localFileLevelComments, localPatchsetComments],
  );

  const openCommentScope = useCallback((path: string | null) => {
    setScopeDraft(null);
    updateThreadUrl();
    setRightPanel(commentScope === path || path === null ? null : { kind: "scope", path });
  }, [commentScope, updateThreadUrl]);

  const saveScopeComment = useCallback((path: string, key: string | null, message: string, resolved: boolean) => {
    const entryKey = key ?? `scope-${nextCommentRef.current++}`;
    setLocalReviewComments((current) => [
      ...current.filter((comment) => comment.key !== entryKey),
      { key: entryKey, path, message, range: { start: 0, end: 0, side: "additions", endSide: "additions" }, unresolved: !resolved },
    ]);
    setScopeDraft(null);
  }, []);

  const deleteScopeComment = useCallback((key: string) => {
    setLocalReviewComments((current) => current.filter((comment) => comment.key !== key));
    setScopeDraft((draft) => draft?.key === key ? null : draft);
  }, []);

  const combinedReviewComments = useMemo(() => [
    ...localReviewComments.filter((comment) => !localReplyComments.some((reply) => reply.key === comment.key)),
    ...localReplyComments,
  ], [localReplyComments, localReviewComments]);

  const generatedReview = useMemo(() => {
    const comments: Record<string, GerritCommentInput[]> = {};
    // When comparing two patchsets, the left-hand side is the base patchset itself, not
    // the parent commit of the reviewed patchset, so those comments have to be posted
    // against that patchset with side REVISION.
    const baseComments: Record<string, GerritCommentInput[]> = {};
    for (const comment of combinedReviewComments) {
      const file = files.find((candidate) => candidate.name === comment.path);
      const side = comment.range.endSide ?? comment.range.side ?? "additions";
      // Existing/ported threads are being replied to on the target patchset.
      // Only a newly selected left-side location belongs to the explicit base.
      const belongsToBasePatchset = data.baseRevisionNumber !== undefined && !comment.inReplyTo && side === "deletions";
      const lineOffset = belongsToBasePatchset
        ? data.baseCommitMessageLineOffset ?? data.commitMessageLineOffset
        : data.commitMessageLineOffset;
      const input = commentInput(comment, file, lineOffset);
      if (belongsToBasePatchset) {
        const path = file?.prevName ?? comment.path;
        // This is now a comment on the base patchset itself, not on one of
        // that commit's parents, so a merge-parent selector must not follow it.
        baseComments[path] = [...(baseComments[path] ?? []), { ...input, side: "REVISION", parent: undefined }];
        continue;
      }
      comments[comment.path] = [...(comments[comment.path] ?? []), input];
    }
    const input: { message?: string; labels?: Record<string, number>; comments?: Record<string, GerritCommentInput[]> } = {};
    if (reviewMessage.trim()) input.message = reviewMessage.trim();
    if (codeReview) input.labels = { "Code-Review": Number(codeReview) };
    if (Object.keys(comments).length) input.comments = comments;
    const host = sshHost.trim() || data.sshHost;
    const command = reviewCommand(host, sshPort, sshUser, data.project, data.changeNumber, data.revisionNumber, input);
    if (!Object.keys(baseComments).length) return command;
    const baseCommand = reviewCommand(host, sshPort, sshUser, data.project, data.changeNumber, data.baseRevisionNumber as number, { comments: baseComments }, "GERRIT_REVIEW_BASE");
    return `${command}\n${baseCommand}`;
  }, [codeReview, combinedReviewComments, data.baseCommitMessageLineOffset, data.baseRevisionNumber, data.changeNumber, data.commitMessageLineOffset, data.project, data.revisionNumber, data.sshHost, files, reviewMessage, sshHost, sshPort, sshUser]);

  const copyGeneratedReview = useCallback(async () => {
    await navigator.clipboard.writeText(generatedReview);
    window.localStorage.setItem(`gerritdiff:ssh-user:${data.host}`, sshUser.trim());
    window.localStorage.setItem(`gerritdiff:ssh-host:${data.host}`, sshHost.trim() || data.sshHost);
    window.localStorage.setItem(`gerritdiff:ssh-port:${data.host}`, sshPort.trim() || "29418");
    setCopied(true);
  }, [data.host, data.sshHost, generatedReview, sshHost, sshPort, sshUser]);

  const openPublishDialog = useCallback(() => {
    setSshUser(window.localStorage.getItem(`gerritdiff:ssh-user:${data.host}`) ?? "");
    setSshHost(window.localStorage.getItem(`gerritdiff:ssh-host:${data.host}`) ?? data.sshHost);
    setSshPort(window.localStorage.getItem(`gerritdiff:ssh-port:${data.host}`) ?? "29418");
    setCopied(false);
    setPublishOpen(true);
  }, [data.host, data.sshHost]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>, item: CodeViewItem<CommentMetadata>) => {
    if (!annotation.metadata) return null;
    if (annotation.metadata.kind === "existing") {
      return <ExistingDiscussion annotation={annotation} expanded={false} localReply={localReplies.find((reply) => reply.key === annotation.metadata?.key)} origin={sourceOrigin} links={data.commentLinks} returnTo={dashboardReturnTo} onToggle={toggleActiveDiscussion} onSaveReply={saveLocalReply} onDeleteReply={deleteLocalReply} />;
    }
    return annotation.metadata.kind === "draft"
      ? <DraftComment annotation={annotation} itemId={item.id} onCancel={removeComment} onSave={saveComment} />
      : <SavedComment annotation={annotation} itemId={item.id} onDelete={removeComment} onSelect={toggleCommentSelection} onEdit={editComment} onToggleResolved={toggleCommentResolved} />;
  }, [dashboardReturnTo, data.commentLinks, deleteLocalReply, editComment, localReplies, removeComment, saveComment, saveLocalReply, sourceOrigin, toggleActiveDiscussion, toggleCommentResolved, toggleCommentSelection]);

  const renderHeaderPrefix = useCallback((item: CodeViewItem<CommentMetadata>) => {
    const disabled = item.type === "diff"
      ? item.fileDiff.splitLineCount === 0 && item.fileDiff.unifiedLineCount === 0
      : item.file.contents.length === 0;
    return <CollapseButton disabled={disabled} collapsed={item.collapsed} onToggle={() => toggleCollapsed(item.id)} />;
  }, [toggleCollapsed]);

  const scrollToItem = useCallback((itemId: string) => {
    viewerRef.current?.scrollTo({ type: "item", id: itemId, align: "start", behavior: "smooth" });
  }, []);

  const loadFullDiff = useCallback(async (itemId: string) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (!viewer || !item || !isDiffItem(item) || !item.fileDiff.isPartial || loadingItems.has(itemId)) return;
    setLoadingItems((current) => new Set(current).add(itemId));
    setRepositoryError("");
    try {
      const [current, parent] = await Promise.all([
        fetchFileContent(revisionSourceUrl, item.fileDiff.name),
        fetchFileContent(revisionSourceUrl, item.fileDiff.prevName ?? item.fileDiff.name, 1),
      ]);
      if (current.binary || parent.binary) throw new Error("Binary files cannot be expanded in CodeView.");
      const fullDiff = parseDiffFromFile(
        { name: item.fileDiff.prevName ?? item.fileDiff.name, contents: parent.content ?? "", cacheKey: `${data.revision}:parent:${item.fileDiff.name}` },
        { name: item.fileDiff.name, contents: current.content ?? "", cacheKey: `${data.revision}:current:${item.fileDiff.name}` },
        undefined,
        true,
      );
      fullDiff.type = item.fileDiff.type;
      fullDiff.prevName = item.fileDiff.prevName;
      item.fileDiff = fullDiff;
      item.version = nextVersion(item);
      viewer.updateItem(item);
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : "Couldn’t expand this file.");
    } finally {
      setLoadingItems((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }, [data.revision, revisionSourceUrl, loadingItems]);

  const selectDiscussion = useCallback(async (thread: DiscussionThread) => {
    const key = `gerrit:${thread.key}`;
    setRightPanel({ kind: "discussion", threadKey: key });
    updateThreadUrl(thread.key);

    // Preserve the selected thread in the URL when its patchset must be loaded.
    if (!threadBelongsToPatchset(thread, data.revisionNumber)) {
      const patchset = threadPatchset(thread) ?? thread.comments.at(-1)?.patchSet;
      if (patchset && patchset !== data.revisionNumber) {
        onPatchsetChange(patchset, thread.key);
        return;
      }
    }

    const anchor = threadAnchor(thread, data.revisionNumber);
    const path = anchor?.path ?? thread.path;
    const itemId = path === "/COMMIT_MSG" ? "commit-message" : pathToChangedId.get(path);
    // Patchset-level threads (and threads on files absent from this patchset) have no
    // anchor in the diff; the side panel still shows them.
    if (!itemId) return;
    if (!anchor) {
      scrollToItem(itemId);
      return;
    }
    await loadFullDiff(itemId);
    const range = commentRange(anchor);
    setSelectedLines(anchor.range ? null : { id: itemId, range });
    viewerRef.current?.scrollTo({ type: "range", id: itemId, range, align: "center", behavior: "smooth" });
  }, [data.revisionNumber, loadFullDiff, onPatchsetChange, pathToChangedId, scrollToItem, updateThreadUrl]);

  useEffect(() => {
    if (!initialThreadId || openedInitialThreadRef.current === initialThreadId) return;
    // Older/shared URLs may contain the Gerrit UUID; newer URLs use the
    // instance key so duplicate ported locations remain independently linkable.
    const thread = discussionThreads.find((candidate) => candidate.key === initialThreadId)
      ?? discussionThreads.find((candidate) => candidate.id === initialThreadId);
    if (!thread) return;
    const frame = requestAnimationFrame(() => {
      openedInitialThreadRef.current = initialThreadId;
      setSidebarMode("discussion");
      saveProjectUiSettings(data.host, data.project, { sidebarMode: "discussion" });
      void selectDiscussion(thread);
    });
    return () => cancelAnimationFrame(frame);
  }, [data.host, data.project, discussionThreads, initialThreadId, selectDiscussion]);

  const openRepositoryFile = useCallback(async (path: string) => {
    const changedId = pathToChangedId.get(path);
    if (changedId) {
      scrollToItem(changedId);
      return;
    }
    const viewer = viewerRef.current;
    const itemId = `repo:${path}`;
    if (!viewer) return;
    if (viewer.getItem(itemId)) {
      scrollToItem(itemId);
      return;
    }
    if (loadingItems.has(itemId)) return;
    setLoadingItems((current) => new Set(current).add(itemId));
    setRepositoryError("");
    try {
      const file = await fetchFileContent(revisionSourceUrl, path);
      if (!file.exists) throw new Error(`${path} does not exist in this patchset.`);
      if (file.binary) throw new Error(`${path} is binary and cannot be displayed.`);
      viewer.addItems([{ id: itemId, type: "file", file: { name: path, contents: file.content ?? "", cacheKey: `${data.revision}:${path}` } }]);
      viewer.scrollTo({ type: "item", id: itemId, align: "start", behavior: "smooth" });
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : `Couldn’t open ${path}.`);
    } finally {
      setLoadingItems((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }, [data.revision, revisionSourceUrl, loadingItems, pathToChangedId, scrollToItem]);

  const renderHeaderMetadata = useCallback((item: CodeViewItem<CommentMetadata>) => {
    const path = item.type === "diff" ? item.fileDiff.name : item.id === "commit-message" ? "/COMMIT_MSG" : undefined;
    const loading = loadingItems.has(item.id);
    const threads = path ? fileLevelThreads.get(path) ?? [] : [];
    const drafts = path ? localFileLevelComments.get(path) ?? [] : [];
    const unresolved = threads.filter((thread) => thread.comments.at(-1)?.unresolved).length;
    const total = threads.length + drafts.length;
    return (
      <>
        {path && (
          <button
            className={`file-comments-button${unresolved > 0 ? " has-unresolved" : ""}${commentScope === path ? " is-open" : ""}`}
            title={total ? `${total} file-level comment${total === 1 ? "" : "s"}${unresolved ? `, ${unresolved} unresolved` : ""}` : "Comment on this file as a whole"}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); openCommentScope(path); }}
          >
            <MessageSquare size={12} />
            {total > 0 && <b>{total}</b>}
            <span>{total ? "File comments" : "Comment on file"}</span>
          </button>
        )}
        {item.type === "diff" && item.fileDiff.isPartial && (
          <button className="load-full-file" disabled={loading} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void loadFullDiff(item.id); }}>
            {loading ? <LoaderCircle className="spinner" size={12} /> : <FileText size={12} />}
            {loading ? "Loading…" : "Load full file"}
          </button>
        )}
      </>
    );
  }, [commentScope, fileLevelThreads, loadFullDiff, loadingItems, localFileLevelComments, openCommentScope]);

  const initials = data.owner.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  const changeOwnerDashboardHref = personDashboardHref(data, dashboardReturnTo, data.owner);
  const reviewers = data.reviewers ?? [];
  const checks = data.checks ?? [];
  const voteText = (value: number | undefined) => value === undefined ? "—" : value > 0 ? `+${value}` : String(value);
  const voteClass = (value: number | undefined) => value === undefined || value === 0 ? "neutral" : value > 0 ? "positive" : "negative";
  const activeThread = activeThreadKey ? discussionThreads.find((thread) => `gerrit:${thread.key}` === activeThreadKey) : undefined;
  const activeAnchor = activeThread ? threadAnchor(activeThread, data.revisionNumber) : undefined;
  const activeRange = activeAnchor ? commentRange(activeAnchor) : undefined;
  const activeAnnotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata> | undefined = activeThread && activeAnchor && activeRange
    ? activeAnchor.path === "/COMMIT_MSG"
      ? {
          lineNumber: activeRange.end,
          metadata: { kind: "existing", key: `gerrit:${activeThread.key}`, range: activeRange, textRange: commentTextRange(activeAnchor), thread: activeThread },
        }
      : {
          side: activeRange.side ?? "additions",
          lineNumber: activeRange.end,
          metadata: { kind: "existing", key: `gerrit:${activeThread.key}`, range: activeRange, textRange: commentTextRange(activeAnchor), thread: activeThread },
        }
    : undefined;

  // Unanchored threads (patchset-level, or on a file not in this patchset) still get a
  // panel-only annotation so they can be read and replied to.
  const activePanelAnnotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata> | undefined =
    activeAnnotation ?? (activeThread
      ? {
          lineNumber: 0,
          metadata: {
            kind: "existing",
            key: `gerrit:${activeThread.key}`,
            range: commentRange(activeThread.comments[0]),
            thread: activeThread,
          },
        }
      : undefined);

  const sidePanelVisible = rightPanel !== null;

  return (
    <div className={`review-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidePanelVisible ? " with-discussion-panel" : ""}`}>
      <aside className={`sidebar pierre-sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}>
        <button type="button" className="sidebar-collapse-toggle" onClick={() => setSidebarCollapsed((current) => { const next = !current; saveProjectUiSettings(data.host, data.project, { sidebarCollapsed: next }); return next; })} aria-label={sidebarCollapsed ? "Expand file browser" : "Collapse file browser"} title={sidebarCollapsed ? "Expand file browser" : "Collapse file browser"}>
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
        <div className="sidebar-tabs">
          <button className={sidebarMode === "changed" ? "active" : ""} onClick={() => { setSidebarMode("changed"); saveProjectUiSettings(data.host, data.project, { sidebarMode: "changed" }); }}>Changed <b>{files.length}</b></button>
          <button className={sidebarMode === "repository" ? "active" : ""} onClick={() => { setSidebarMode("repository"); saveProjectUiSettings(data.host, data.project, { sidebarMode: "repository" }); }}>Repository</button>
          <button className={sidebarMode === "discussion" ? "active" : ""} onClick={() => { setSidebarMode("discussion"); saveProjectUiSettings(data.host, data.project, { sidebarMode: "discussion" }); }} title={`${currentDiscussionCount} on this patchset, ${discussionThreads.length} total`}>Discussion <b>{currentDiscussionCount}/{discussionThreads.length}</b></button>
        </div>
        {sidebarMode === "changed" && <ReviewFileTree files={files} onSelect={scrollToItem} />}
        {sidebarMode === "repository" && <RepositoryBrowser changedFiles={files} sourceUrl={revisionSourceUrl} onOpenFile={openRepositoryFile} />}
        {sidebarMode === "discussion" && <DiscussionSidebar threads={discussionThreads} revisionNumber={data.revisionNumber} onSelect={(thread) => void selectDiscussion(thread)} />}
        {sidebarMode === "repository" && (
          <form className="known-path-form" onSubmit={(event) => { event.preventDefault(); const path = knownPath.trim().replace(/^\/+/, ""); if (path) void openRepositoryFile(path); }}>
            <input value={knownPath} onChange={(event) => setKnownPath(event.target.value)} placeholder="Open a known path…" />
            <button type="submit" disabled={!knownPath.trim()}>Open</button>
          </form>
        )}
        <SidebarDiffStats files={files} additions={data.insertions} deletions={data.deletions} />
      </aside>

      <section className="change-main pierre-main">
        <div className="change-header">
          <div className="change-title-row">
            <div className="change-kicker">
              <span className={`change-status ${data.status.toLowerCase().replaceAll(" ", "-")}`}>{data.status}</span>
              <span>{data.project}</span><span>/</span><span>change {data.changeNumber}</span>
            </div>
            <h1 title={data.subject}>{data.subject}</h1>
            <button type="button" className="publish-review-button header-review-button" onClick={openPublishDialog} title="Publish review" aria-label="Publish review">
              <Send size={13} /> <span>Publish review</span>
            </button>
          </div>
          <div className="change-meta">
            <span className="avatar" style={data.owner.avatarUrl ? { backgroundImage: `url(${data.owner.avatarUrl})` } : undefined}>{data.owner.avatarUrl ? null : initials}</span>
            {changeOwnerDashboardHref ? <a className="person-dashboard-link" href={changeOwnerDashboardHref}>{data.owner.name}</a> : <strong>{data.owner.name}</strong>}
            <span>updated {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(data.updated))}</span>
            <span className="separator">•</span>
            <GitBranch size={14} /><code>{data.branch}</code>
            <div className="patchset-picker">
              <span>Base</span>
              <select aria-label="Base patchset" value={data.baseRevisionNumber ?? "parent"} disabled={comparisonLoading} onChange={(event) => onBaseChange(event.target.value === "parent" ? undefined : Number(event.target.value))}>
                <option value="parent">Parent</option>
                {data.revisions.filter((revision) => revision.number !== data.revisionNumber).map((revision) => <option key={revision.revision} value={revision.number}>{revision.number}</option>)}
              </select>
              <small>to patchset</small>
              <select aria-label="Target patchset" value={data.revisionNumber} disabled={comparisonLoading} onChange={(event) => onPatchsetChange(Number(event.target.value))}>
                {data.revisions.map((revision) => <option key={revision.revision} value={revision.number}>{revision.number}{revision.number === data.revisions.at(-1)?.number ? " (latest)" : ""}</option>)}
              </select>
            </div>
            {data.relationChain.length > 1 && (
              <button
                type="button"
                className="relation-chain-button"
                aria-expanded={relationPanelOpen}
                title={`${data.relationChain.length} changes in the relation chain`}
                onClick={() => {
                  updateThreadUrl();
                  setRightPanel(relationPanelOpen ? null : { kind: "relation" });
                }}
              >
                <GitBranch size={12} />
                <span>Relation chain</span>
                <b>{data.relationChain.length}</b>
              </button>
            )}
            <button
              type="button"
              className={`patchset-discussions-button${unresolvedPatchsetDiscussionCount > 0 ? " has-unresolved" : ""}`}
              aria-expanded={commentScope === "/PATCHSET_LEVEL"}
              title={patchsetLevelThreads.length
                ? `${patchsetLevelThreads.length} patchset-level comment${patchsetLevelThreads.length === 1 ? "" : "s"}${unresolvedPatchsetDiscussionCount ? `, ${unresolvedPatchsetDiscussionCount} unresolved` : ""}`
                : "Comment on the whole patchset, not a specific file"}
              onClick={() => {
                openCommentScope("/PATCHSET_LEVEL");
              }}
            >
              <MessageSquare size={12} />
              <span>{patchsetLevelThreads.length || localPatchsetComments.length
                ? `${patchsetLevelThreads.length + localPatchsetComments.length} patchset comment${patchsetLevelThreads.length + localPatchsetComments.length === 1 ? "" : "s"}`
                : "Patchset comment"}</span>
              {unresolvedPatchsetDiscussionCount > 0 && <b>{unresolvedPatchsetDiscussionCount} unresolved</b>}
              {localPatchsetComments.length > 0 && <b className="is-draft">{localPatchsetComments.length} draft</b>}
            </button>
            {comparisonLoading && (
              <span className="comparison-loading" role="status" aria-label="Loading patchset" title="Loading patchset…">
                <LoaderCircle className="spinner" size={13} />
              </span>
            )}
          </div>
          <div className={`reviewers-summary${reviewersExpanded ? " is-expanded" : ""}`} aria-label="Current reviewers and votes">
            <button type="button" className="reviewers-toggle" aria-expanded={reviewersExpanded} onClick={() => setReviewersExpanded((current) => {
              const next = !current;
              saveReviewersExpanded(next);
              return next;
            })}>
              <span className="reviewers-label">Reviewers</span>
              <b>{reviewers.length}</b>
              <ChevronDown size={12} />
            </button>
            {reviewersExpanded && (
              <div className="reviewers-list">
                {reviewers.length ? reviewers.map((reviewer, index) => {
                  const reviewerInitials = reviewer.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
                  const dashboardHref = personDashboardHref(data, dashboardReturnTo, reviewer);
                  const content = (
                    <>
                      <span className="reviewer-avatar">{reviewer.avatarUrl ? <Image src={reviewer.avatarUrl} alt="" width={19} height={19} unoptimized /> : reviewerInitials}</span>
                      <strong>{reviewer.name}</strong>
                      {reviewer.codeReview !== undefined && reviewer.codeReview !== 0 && (
                        <span className={`reviewer-vote ${voteClass(reviewer.codeReview)}`} title={`Code-Review ${voteText(reviewer.codeReview)}`} aria-label={`Code-Review ${voteText(reviewer.codeReview)}`}>CR {voteText(reviewer.codeReview)}</span>
                      )}
                      {reviewer.verified !== undefined && reviewer.verified !== 0 && (
                        <span className={`reviewer-vote verified ${voteClass(reviewer.verified)}`} title={`Verified ${voteText(reviewer.verified)}`} aria-label={`Verified ${voteText(reviewer.verified)}`}>V {voteText(reviewer.verified)}</span>
                      )}
                    </>
                  );
                  return dashboardHref
                    ? <a className="reviewer-chip" key={reviewer.email ?? `${reviewer.name}:${index}`} href={dashboardHref} title={`View ${reviewer.name}'s changes`}>{content}</a>
                    : <span className="reviewer-chip" key={reviewer.email ?? `${reviewer.name}:${index}`} title={reviewer.email}>{content}</span>;
                }) : <span className="reviewers-empty">No current reviewers</span>}
              </div>
            )}
          </div>
          {checks.length > 0 && (
            <div className="automation-results" aria-label="Automation results for this patchset">
              <span className="automation-results-label">Checks</span>
              {checks.map((check) => (
                <a className={`automation-check ${check.result.toLowerCase()}`} href={check.url} target="_blank" rel="noreferrer" key={check.url}>
                  {check.result === "SUCCESS" ? <Check size={11} /> : <X size={11} />}
                  <strong>{check.name}</strong>
                  <span>{check.result.replace("_", " ")}</span>
                  <ExternalLink size={10} />
                </a>
              ))}
            </div>
          )}
        </div>
        {repositoryError && <div className="repository-error"><X size={13} /> <span>{repositoryError}</span><button onClick={() => setRepositoryError("")} aria-label="Dismiss"><X size={12} /></button></div>}
        {searchOpen && (
          <form
            className="code-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (searchMatches.length) setSearchIndex((current) => (current + 1) % searchMatches.length);
            }}
          >
            <Search size={14} />
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Find in diff"
              placeholder="Find in diff"
              value={searchQuery}
              onChange={(event) => { setSearchQuery(event.target.value); setSearchIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSearchOpen(false);
                  setSearchQuery("");
                } else if (event.key === "Enter" && event.shiftKey && searchMatches.length) {
                  event.preventDefault();
                  setSearchIndex((current) => (current - 1 + searchMatches.length) % searchMatches.length);
                }
              }}
            />
            <span>{searchQuery.trim() ? searchMatches.length ? `${Math.min(searchIndex + 1, searchMatches.length)} / ${searchMatches.length}` : "No results" : ""}</span>
            <button type="button" disabled={!searchMatches.length} aria-label="Previous match" onClick={() => setSearchIndex((current) => (current - 1 + searchMatches.length) % searchMatches.length)}><ChevronUp size={13} /></button>
            <button type="submit" disabled={!searchMatches.length} aria-label="Next match"><ChevronDown size={13} /></button>
            <button type="button" aria-label="Close search" onClick={() => { setSearchOpen(false); setSearchQuery(""); }}><X size={13} /></button>
          </form>
        )}
        <div className="diff-toolbar pierre-toolbar">
          <span><strong>{files.length}</strong> files changed</span>
          <span className="comment-hint"><MessageSquare size={13} /> Select lines or click <b>+</b> in the gutter to comment</span>
          {localCommentCount > 0 && <span className="comment-count">{localCommentCount} local comment{localCommentCount === 1 ? "" : "s"}</span>}
          <button
            type="button"
            className={`moved-code-toggle${movedCodeOpen ? " active" : ""}`}
            aria-pressed={movedCodeOpen}
            title="Compare the old state of one file with the new state of another"
            onClick={() => {
              setMovedCodeOpen((current) => !current);
              setSearchOpen(false);
              setSearchQuery("");
              setCodeTextSelection(null);
            }}
          >
            <Columns2 size={13} /> Compare files
          </button>
          {!movedCodeOpen && (
            <div className="diff-layout-buttons" aria-label="Diff layout">
              <button type="button" className={diffStyle === "split" ? "active" : ""} aria-pressed={diffStyle === "split"} onClick={() => { setDiffStyle("split"); saveProjectUiSettings(data.host, data.project, { diffStyle: "split" }); }}><Columns2 size={13} /> Side by side</button>
              <button type="button" className={diffStyle === "unified" ? "active" : ""} aria-pressed={diffStyle === "unified"} onClick={() => { setDiffStyle("unified"); saveProjectUiSettings(data.host, data.project, { diffStyle: "unified" }); }}><Rows3 size={13} /> Unified</button>
            </div>
          )}
          <details className="view-settings">
            <summary title="Diff display settings">
              <Settings2 size={14} />
              <span>View</span>
              <ChevronDown className="view-settings-chevron" size={12} />
            </summary>
            <div className="view-settings-menu">
              {!movedCodeOpen && (
                <div className="view-settings-row view-layout-setting">
                  <span>Layout</span>
                  <div>
                    <button type="button" className={diffStyle === "split" ? "active" : ""} aria-pressed={diffStyle === "split"} onClick={() => { setDiffStyle("split"); saveProjectUiSettings(data.host, data.project, { diffStyle: "split" }); }}><Columns2 size={13} /> Side by side</button>
                    <button type="button" className={diffStyle === "unified" ? "active" : ""} aria-pressed={diffStyle === "unified"} onClick={() => { setDiffStyle("unified"); saveProjectUiSettings(data.host, data.project, { diffStyle: "unified" }); }}><Rows3 size={13} /> Unified</button>
                  </div>
                </div>
              )}
              {movedCodeOpen && (
                <label className="view-settings-row">
                  <span>Ignore indentation</span>
                  <input type="checkbox" checked={ignoreIndentation} onChange={(event) => { setIgnoreIndentation(event.target.checked); saveProjectUiSettings(data.host, data.project, { ignoreIndentation: event.target.checked }); }} />
                </label>
              )}
              <label className="view-settings-row">
                <span><Pilcrow size={13} /> Show whitespace</span>
                <input type="checkbox" checked={showWhitespace} onChange={(event) => { setShowWhitespace(event.target.checked); saveProjectUiSettings(data.host, data.project, { showWhitespace: event.target.checked }); }} />
              </label>
              <label className="view-settings-row">
                <span>Tab size</span>
                <select
                  aria-label="Tab size"
                  value={tabSize}
                  onChange={(event) => {
                    const nextTabSize = Number(event.target.value);
                    setTabSize(nextTabSize);
                    saveProjectUiSettings(data.host, data.project, { tabSize: nextTabSize });
                  }}
                >
                  <option value={2}>2 spaces</option>
                  <option value={4}>4 spaces</option>
                  <option value={8}>8 spaces</option>
                </select>
              </label>
            </div>
          </details>
          <span className="summary-add">+{data.insertions}</span>
          <span className="summary-del">−{data.deletions}</span>
        </div>
        <WorkerPoolContextProvider poolOptions={WORKER_POOL_OPTIONS} highlighterOptions={WORKER_HIGHLIGHTER_OPTIONS}>
          <div className="review-code-surface">
            <CodeView<CommentMetadata>
              ref={viewerRef}
              containerRef={codeViewContainerRef}
              initialItems={initialItems}
              className="pierre-code-view"
              options={options}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              renderAnnotation={renderAnnotation}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
            />
            {movedCodeOpen && (
              <MovedCodeCompare
                key={`${data.revision}:${data.baseRevisionNumber ?? "parent"}`}
                sourceUrl={revisionSourceUrl}
                oldFiles={movedCodeFiles.old}
                newFiles={movedCodeFiles.new}
                baseLabel={data.baseRevisionNumber ? `Patchset ${data.baseRevisionNumber}` : "Parent"}
                targetLabel={`Patchset ${data.revisionNumber}`}
                theme={theme}
                tabSize={tabSize}
                showWhitespace={showWhitespace}
                ignoreIndentation={ignoreIndentation}
                onClose={() => setMovedCodeOpen(false)}
              />
            )}
          </div>
        </WorkerPoolContextProvider>
        {codeTextSelection && (
          <button
            type="button"
            className="text-selection-comment"
            style={{ top: codeTextSelection.top, left: codeTextSelection.left }}
            aria-keyshortcuts="C"
            title="Comment on selected text (C)"
            onPointerDown={(event) => event.preventDefault()}
            onClick={commentOnTextSelection}
          >
            <MessageSquare size={13} /> Comment <kbd>C</kbd>
          </button>
        )}
      </section>

      {sidePanelVisible && (
        <aside className="discussion-panel" aria-label={relationPanelOpen ? "Relation chain" : commentScope ? scopeLabel(commentScope) : "Selected discussion"}>
          <div className="discussion-panel-head">
            <div>
              <span>{relationPanelOpen ? "Relation chain" : commentScope ? scopeLabel(commentScope) : "Discussion"}</span>
              <strong title={commentScope ?? undefined}>{relationPanelOpen
                ? `${data.relationChain.length} change${data.relationChain.length === 1 ? "" : "s"}`
                : commentScope
                  ? `${commentScope === "/PATCHSET_LEVEL" ? `Patchset ${data.revisionNumber}` : commentScope} · ${scopeThreads.length} thread${scopeThreads.length === 1 ? "" : "s"}${scopeDrafts.length ? `, ${scopeDrafts.length} draft` : ""}`
                  : `${activeThread?.comments.length ?? 0} comment${activeThread?.comments.length === 1 ? "" : "s"}`}</strong>
            </div>
            <button type="button" onClick={() => { setRightPanel(null); updateThreadUrl(); }} aria-label="Close side panel"><X size={15} /></button>
          </div>
          <div className={`discussion-panel-body${commentScope && !relationPanelOpen ? " patchset-discussion-list" : ""}`}>
            {relationPanelOpen ? <RelationChainPanel relations={data.relationChain} /> : null}
            {!relationPanelOpen && commentScope ? scopeThreads.map((thread) => {
              const range = commentRange(thread.comments[0]);
              const annotation: LineAnnotation<CommentMetadata> = {
                lineNumber: 0,
                metadata: { kind: "existing", key: `gerrit:${thread.key}`, range, thread },
              };
              return (
                <ExistingDiscussion
                  key={thread.key}
                  annotation={annotation}
                  expanded
                  localReply={localReplies.find((reply) => reply.key === `gerrit:${thread.key}`)}
                  origin={sourceOrigin}
                  links={data.commentLinks}
                  returnTo={dashboardReturnTo}
                  onToggle={() => undefined}
                  onSaveReply={saveLocalReply}
                  onDeleteReply={deleteLocalReply}
                />
              );
            }) : null}
            {commentScope && !relationPanelOpen && (
              <>
                {scopeDrafts.map((comment) => (
                  <div className="comment-card patchset-draft-card" key={comment.key}>
                    <div className="patchset-draft-head">
                      <strong>{commentScope === "/PATCHSET_LEVEL" ? "Patchset comment draft" : "File comment draft"}</strong>
                      <span className={`thread-state ${comment.unresolved ? "is-unresolved" : "is-resolved"}`}>{comment.unresolved ? "Unresolved" : "Resolved"}</span>
                    </div>
                    <p>{comment.message}</p>
                    <div className="discussion-actions">
                      <button onClick={() => setScopeDraft({ key: comment.key, message: comment.message, resolved: !comment.unresolved })}>Edit</button>
                      <button onClick={() => deleteScopeComment(comment.key)}>Discard</button>
                    </div>
                  </div>
                ))}
                {scopeDraft ? (
                  <form
                    className="comment-card discussion-reply patchset-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const trimmed = scopeDraft.message.trim();
                      if (trimmed) saveScopeComment(commentScope, scopeDraft.key, trimmed, scopeDraft.resolved);
                    }}
                  >
                    <textarea autoFocus rows={4} value={scopeDraft.message} onChange={(event) => setScopeDraft((draft) => draft ? { ...draft, message: event.target.value } : draft)} placeholder={commentScope === "/PATCHSET_LEVEL" ? "Comment on the whole patchset…" : "Comment on this file as a whole…"} />
                    <div className="reply-options">
                      <button className={`resolution-toggle ${scopeDraft.resolved ? "is-resolved" : "is-unresolved"}`} type="button" aria-pressed={scopeDraft.resolved} onClick={() => setScopeDraft((draft) => draft ? { ...draft, resolved: !draft.resolved } : draft)}>
                        <CircleCheck size={12} /> {scopeDraft.resolved ? "Resolved" : "Unresolved"}
                      </button>
                      <span>Unresolved comments block until someone marks them done.</span>
                    </div>
                    <div>
                      <span>{commentScope === "/PATCHSET_LEVEL" ? <>Sent as a <code>/PATCHSET_LEVEL</code> comment when you publish.</> : <>Sent as a file comment on <code>{commentScope}</code> when you publish.</>}</span>
                      <button type="button" onClick={() => setScopeDraft(null)}>Cancel</button>
                      <button type="submit" disabled={!scopeDraft.message.trim()}>Save comment</button>
                    </div>
                  </form>
                ) : (
                  <button type="button" className="patchset-add-comment" onClick={() => setScopeDraft({ key: null, message: "", resolved: false })}>
                    <MessageSquare size={13} /> {commentScope === "/PATCHSET_LEVEL" ? "Add patchset comment" : "Add file comment"}
                  </button>
                )}
                {scopeThreads.length === 0 && scopeDrafts.length === 0 && !scopeDraft && (
                  <p className="patchset-empty-hint">{commentScope === "/PATCHSET_LEVEL"
                    ? "Patchset comments apply to the change as a whole instead of a file or line — and unlike the cover message, they can be resolved and replied to."
                    : "File comments apply to the whole file instead of a specific line — useful for “this file should be split up” style feedback."}</p>
                )}
              </>
            )}
            {!commentScope && !relationPanelOpen && activePanelAnnotation ? (
              <ExistingDiscussion
                annotation={activePanelAnnotation}
                expanded
                localReply={localReplies.find((reply) => reply.key === activeThreadKey)}
                origin={sourceOrigin}
                links={data.commentLinks}
                returnTo={dashboardReturnTo}
                onToggle={() => { setRightPanel(null); updateThreadUrl(); }}
                onSaveReply={saveLocalReply}
                onDeleteReply={deleteLocalReply}
              />
            ) : null}
          </div>
        </aside>
      )}

      {publishOpen && (
        <div className="publish-review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPublishOpen(false); }}>
          <section className="publish-review-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-review-title">
            <header>
              <div><Terminal size={16} /><span><strong id="publish-review-title">Publish review over SSH</strong><small>Copy and run this command in your terminal.</small></span></div>
              <button type="button" onClick={() => setPublishOpen(false)} aria-label="Close publish dialog"><X size={16} /></button>
            </header>
            <div className="publish-review-fields">
              <label><span>SSH username</span><input value={sshUser} onChange={(event) => { setSshUser(event.target.value); setCopied(false); }} placeholder="YOUR_USERNAME" /></label>
              <label><span>SSH host</span><input value={sshHost} onChange={(event) => { setSshHost(event.target.value); setCopied(false); }} /></label>
              <label><span>SSH port</span><input value={sshPort} onChange={(event) => { setSshPort(event.target.value); setCopied(false); }} inputMode="numeric" /></label>
              <label className="publish-review-vote"><span>Code-Review</span><select value={codeReview} onChange={(event) => { setCodeReview(event.target.value); setCopied(false); }}><option value="">No vote</option><option value="-2">-2</option><option value="-1">-1</option><option value="0">0</option><option value="1">+1</option><option value="2">+2</option></select></label>
              <label className="publish-review-message"><span>Cover message</span><textarea value={reviewMessage} onChange={(event) => { setReviewMessage(event.target.value); setCopied(false); }} placeholder="Optional message posted alongside your vote…" /><small>Posted as the change message. For something that can be resolved and replied to, use a patchset comment instead.</small></label>
            </div>
            {combinedReviewComments.length > 0 && (
              <div className="publish-review-summary">
                <div className="publish-review-summary-head">
                  <MessageSquare size={12} />
                  <strong>{combinedReviewComments.length} comment{combinedReviewComments.length === 1 ? "" : "s"} in this review</strong>
                </div>
                <ul>
                  {combinedReviewComments.map((comment) => (
                    <li key={comment.key}>
                      <span className="publish-review-summary-where">
                        <b title={comment.path}>{commentPathLabel(comment.path)}</b>
                        <i>{commentLocationLabel(comment)}</i>
                      </span>
                      <span className="publish-review-summary-tags">
                        <span className="publish-review-tag">{comment.inReplyTo ? "Reply" : "New comment"}</span>
                        {comment.unresolved !== undefined && (
                          <span className={`publish-review-tag ${comment.unresolved ? "is-unresolved" : "is-resolved"}`}>{comment.unresolved ? "Unresolved" : "Resolved"}</span>
                        )}
                      </span>
                      <p>{commentSummary(comment.message)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="publish-review-code">
              <div><span>{data.host} · change {data.changeNumber}, patchset {data.revisionNumber}</span><button type="button" onClick={() => void copyGeneratedReview()}><Copy size={13} /> {copied ? "Copied" : "Copy command"}</button></div>
              <pre><code>{generatedReview}</code></pre>
            </div>
            <p>The command sends Gerrit a <code>ReviewInput</code> JSON document on stdin, including local inline comments and replies. Comments are keyed by file path; <code>/PATCHSET_LEVEL</code> is Gerrit&rsquo;s reserved path for change-wide comments that aren&rsquo;t attached to a file, and <code>/COMMIT_MSG</code> targets the commit message. When you compare two patchsets, comments on the left-hand side belong to the base patchset, so they are sent as a second command.</p>
          </section>
        </div>
      )}
    </div>
  );
}
