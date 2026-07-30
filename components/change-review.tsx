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
import { Check, ChevronDown, CircleCheck, Columns2, Copy, FileText, GitBranch, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Pilcrow, Quote, Reply, Rows3, Send, Settings2, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RepositoryBrowser } from "@/components/repository-browser";
import type { ChangeData, GerritComment, RelatedChange } from "@/lib/types";
import type { GerritDiffTheme } from "@/lib/theme";

type DiscussionThread = { id: string; path: string; comments: GerritComment[] };

type GerritTextRange = { start_line: number; start_character: number; end_line: number; end_character: number };

type CommentMetadata =
  | { kind: "draft"; key: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; unresolved?: boolean }
  | { kind: "saved"; key: string; author: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; unresolved?: boolean }
  | { kind: "existing"; key: string; range: SelectedLineRange; textRange?: GerritTextRange; thread: DiscussionThread };

type ActiveDraft = { itemId: string; key: string };
type LocalReply = { key: string; message: string; resolved: boolean };
type LocalReviewComment = { key: string; path: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; inReplyTo?: string; unresolved?: boolean };
type CodeTextSelection = { itemId: string; range: SelectedLineRange; textRange: GerritTextRange; top: number; left: number };
type GerritCommentInput = {
  side: "PARENT" | "REVISION";
  line?: number;
  range?: { start_line: number; start_character: number; end_line: number; end_character: number };
  in_reply_to?: string;
  message: string;
  unresolved?: boolean;
};

const COMMENT_HIGHLIGHT_NAME = "gerrit-comment-range";
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
  sidebarCollapsed?: boolean;
  sidebarMode?: "changed" | "repository" | "discussion";
  rightPanelOpen?: boolean;
};

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

function updateWhitespaceMarkers(root: HTMLElement | ShadowRoot, visible: boolean) {
  const markerRoot = root instanceof ShadowRoot ? root.host : root;
  markerRoot.toggleAttribute("data-show-whitespace", visible);
  if (!visible) return;

  const lines = root instanceof HTMLElement && root.matches("[data-line]")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>("[data-line]"));
  for (const line of lines) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest("[data-whitespace-marker]")) continue;
      if (/[ \t]/.test(node.textContent ?? "")) textNodes.push(node as Text);
    }
    for (const textNode of textNodes) {
      const text = textNode.data;
      const fragment = document.createDocumentFragment();
      for (const part of text.split(/( +|\t)/)) {
        if (!part) continue;
        if (part === "\t" || /^ +$/.test(part)) {
          const marker = document.createElement("span");
          marker.dataset.whitespaceMarker = part === "\t" ? "tab" : "space";
          marker.textContent = part;
          fragment.append(marker);
        } else {
          fragment.append(part);
        }
      }
      textNode.replaceWith(fragment);
    }
  }
}

function gitStatusFor(file: FileDiffMetadata): GitStatus {
  if (file.type === "new") return "added";
  if (file.type === "deleted") return "deleted";
  if (file.type === "rename-pure" || file.type === "rename-changed") return "renamed";
  return "modified";
}

function buildDiscussionThreads(comments: GerritComment[]): DiscussionThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const grouped = new Map<string, GerritComment[]>();
  for (const comment of comments) {
    let root = comment;
    const visited = new Set([comment.id]);
    while (root.inReplyTo) {
      const parent = byId.get(root.inReplyTo);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      root = parent;
    }
    grouped.set(root.id, [...(grouped.get(root.id) ?? []), comment]);
  }
  return [...grouped.entries()].map(([id, threadComments]) => {
    const sorted = threadComments.toSorted((a, b) => a.updated.localeCompare(b.updated));
    return { id, path: sorted[0]?.path ?? "/PATCHSET_LEVEL", comments: sorted };
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

function textPosition(line: HTMLElement, character: number) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, character);
  let last: Text | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  return last ? { node: last, offset: last.data.length } : { node: line, offset: 0 };
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

function commentInput(comment: LocalReviewComment, file?: FileDiffMetadata): GerritCommentInput {
  const side = comment.range.endSide ?? comment.range.side ?? "additions";
  const input: GerritCommentInput = {
    side: side === "deletions" ? "PARENT" : "REVISION",
    message: comment.message,
  };
  if (comment.inReplyTo) input.in_reply_to = comment.inReplyTo;
  if (comment.unresolved !== undefined) input.unresolved = comment.unresolved;
  if (comment.textRange) {
    input.range = comment.textRange;
    return input;
  }
  if (comment.range.start === comment.range.end || !file) {
    if (comment.range.end > 0) input.line = comment.range.end;
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
    input.line = comment.range.end;
    return input;
  }
  input.range = {
    start_line: comment.range.start,
    start_character: 0,
    end_line: comment.range.end,
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

function reviewCommand(host: string, port: string, user: string, change: number, patchset: number, input: object) {
  const destination = `${user.trim() || "YOUR_USERNAME"}@${host}`;
  return `ssh -p ${shellArg(port.trim() || "29418")} ${shellArg(destination)} gerrit review --json ${change},${patchset} <<'GERRIT_REVIEW'\n${JSON.stringify(input, null, 2)}\nGERRIT_REVIEW`;
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
        <div className="reply-options">
          <button className={`resolution-toggle ${unresolved ? "is-unresolved" : "is-resolved"}`} type="button" aria-pressed={!unresolved} onClick={() => setUnresolved((current) => !current)}>
            <CircleCheck size={12} /> {unresolved ? "Unresolved" : "Resolved"}
          </button>
          <span>Unresolved comments block until someone marks them done.</span>
        </div>
        <div className="comment-actions">
          <span>Ctrl ↵ to submit</span>
          <button type="button" className="comment-cancel" onClick={() => onCancel(itemId, key)}><X size={14} /> Cancel</button>
          <button type="submit" disabled={!trimmed}><Send size={13} /> {metadata?.message ? "Save comment" : "Add comment"}</button>
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

function CommentText({ comment }: { comment: GerritComment }) {
  const { message } = comment;
  const suggestion = message.match(/```suggestion\s*\n([\s\S]*?)```/);
  const renderText = (text: string, key: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return (
      <div className="comment-markup" key={key}>
        {trimmed.split(/\n{2,}/).map((block, index) => block.split("\n").every((line) => line.trimStart().startsWith(">"))
          ? <blockquote key={index}>{block.split("\n").map((line) => line.replace(/^\s*>\s?/, "")).join("\n")}</blockquote>
          : <p key={index}>{block}</p>)}
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

function ExistingDiscussion({ annotation, expanded, localReply, onToggle, onSaveReply, onDeleteReply }: { annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>; expanded: boolean; localReply?: LocalReply; onToggle(key: string): void; onSaveReply(reply: LocalReply): void; onDeleteReply(key: string): void }) {
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
            <CommentText comment={comment} />
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
      <button className={latest?.unresolved ? "sidebar-thread-unresolved" : "sidebar-thread-resolved"} key={thread.id} onClick={() => onSelect(thread)}>
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

export function ChangeReview({ data, theme, onPatchsetChange, onBaseChange }: { data: ChangeData; theme: GerritDiffTheme; onPatchsetChange(patchset: number): void; onBaseChange(base?: number): void }) {
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const codeViewContainerRef = useRef<HTMLDivElement | null>(null);
  const activeDraftRef = useRef<ActiveDraft | null>(null);
  const nextCommentRef = useRef(1);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [codeTextSelection, setCodeTextSelection] = useState<CodeTextSelection | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [tabSize, setTabSize] = useState(2);
  const [sidebarMode, setSidebarMode] = useState<"changed" | "repository" | "discussion">("changed");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [knownPath, setKnownPath] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingItems, setLoadingItems] = useState<ReadonlySet<string>>(() => new Set());
  const [localReplies, setLocalReplies] = useState<LocalReply[]>([]);
  const [localReviewComments, setLocalReviewComments] = useState<LocalReviewComment[]>([]);
  const [activeThreadKey, setActiveThreadKey] = useState<string | null>(null);
  // null = closed; otherwise the path whose unanchored comments the panel shows
  // ("/PATCHSET_LEVEL" for change-wide, or a file path for file-level).
  const [commentScope, setCommentScope] = useState<string | null>(null);
  const pendingThreadRef = useRef<{ key: string; patchset: number } | null>(null);
  const [scopeDraft, setScopeDraft] = useState<{ key: string | null; message: string; resolved: boolean } | null>(null);
  const [relationPanelOpen, setRelationPanelOpen] = useState(data.relationChain.length > 1);
  const [publishOpen, setPublishOpen] = useState(false);
  const [sshUser, setSshUser] = useState("");
  const [sshHost, setSshHost] = useState(data.host);
  const [sshPort, setSshPort] = useState("29418");
  const [reviewMessage, setReviewMessage] = useState("");
  const [codeReview, setCodeReview] = useState("");
  const [copied, setCopied] = useState(false);
  const commitMessageContent = data.commitMessage.trim();

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
  const discussionThreads = useMemo(() => buildDiscussionThreads(data.comments), [data.comments]);
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
            metadata: { kind: "existing", key: `gerrit:${thread.id}`, range, textRange: commentTextRange(anchor), thread },
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
            metadata: { kind: "existing", key: `gerrit:${thread.id}`, range, textRange: commentTextRange(anchor), thread },
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

  useEffect(() => {
    const settings = readProjectUiSettings(data.host, data.project);
    const frame = requestAnimationFrame(() => {
      setTabSize(settings.tabSize === 4 || settings.tabSize === 8 ? settings.tabSize : 2);
      setShowWhitespace(settings.showWhitespace ?? false);
      setSidebarCollapsed(settings.sidebarCollapsed ?? false);
      if (settings.sidebarMode === "repository" || settings.sidebarMode === "discussion") setSidebarMode(settings.sidebarMode);
      else setSidebarMode("changed");
      setRelationPanelOpen(settings.rightPanelOpen ?? data.relationChain.length > 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [data.host, data.project, data.relationChain.length]);

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

  const refreshCommentHighlights = useCallback(() => {
    const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }).highlights;
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
        setCodeTextSelection({
          itemId: rendered.id,
          range,
          textRange: {
            start_line: start,
            start_character: startCharacter,
            end_line: end,
            end_character: endCharacter,
          },
          top: Math.max(8, rect.top - 38),
          left: Math.min(window.innerWidth - 120, Math.max(8, rect.left + rect.width / 2 - 54)),
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
    let frame = requestAnimationFrame(refreshCommentHighlights);
    const observedRoots = new WeakSet<ShadowRoot>();
    const shadowObservers: MutationObserver[] = [];
    const scheduleRefresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshCommentHighlights);
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
      (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights?.delete(COMMENT_HIGHLIGHT_NAME);
    };
  }, [refreshCommentHighlights]);

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

  const renderWhitespaceMarkers = useCallback((node: HTMLElement) => {
    updateWhitespaceMarkers(node, showWhitespace);
  }, [showWhitespace]);

  useEffect(() => {
    for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
      const root = rendered.element.shadowRoot;
      if (root) updateWhitespaceMarkers(root, showWhitespace);
    }
  }, [showWhitespace]);

  const options = useMemo<CodeViewOptions<CommentMetadata>>(() => ({
    layout: { paddingTop: 0, gap: 1, paddingBottom: 0 },
    themeType: theme,
    theme: theme === "dark" ? "pierre-dark" : "pierre-light",
    diffStyle,
    diffIndicators: "bars",
    overflow: "scroll",
    lineDiffType: "word-alt",
    lineHoverHighlight: "number",
    enableLineSelection: true,
    enableGutterUtility: true,
    stickyHeaders: true,
    hunkSeparators: "line-info-basic",
    unsafeCSS: `
      :host { --diffs-tab-size: ${tabSize}; }
      ::highlight(${COMMENT_HIGHLIGHT_NAME}) { background-color: rgba(231, 177, 54, .38); text-decoration: underline 1px rgba(245, 198, 83, .9); text-underline-offset: 2px; }
      :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="space"] { color: transparent; background-image: radial-gradient(circle, color-mix(in srgb, var(--diffs-fg) 42%, transparent) 1px, transparent 1.2px); background-position: .5ch center; background-repeat: repeat-x; background-size: 1ch 100%; }
      :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="tab"] { position: relative; color: transparent; }
      :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="tab"]::before { content: "→"; position: absolute; inset-inline-start: 0; color: color-mix(in srgb, var(--diffs-fg) 48%, transparent); pointer-events: none; }
    `,
    onPostRender: renderWhitespaceMarkers,
    onGutterUtilityClick(range, context) {
      createDraft(range, context.item.id);
    },
  }), [createDraft, diffStyle, renderWhitespaceMarkers, tabSize, theme]);

  const saveLocalReply = useCallback((reply: LocalReply) => {
    setLocalReplies((current) => [...current.filter((entry) => entry.key !== reply.key), reply]);
  }, []);

  const deleteLocalReply = useCallback((key: string) => {
    setLocalReplies((current) => current.filter((entry) => entry.key !== key));
  }, []);

  const toggleActiveDiscussion = useCallback((key: string) => {
    setActiveThreadKey((current) => {
      const next = current === key ? null : key;
      if (next) {
        setRelationPanelOpen(false);
        setCommentScope(null);
      }
      saveProjectUiSettings(data.host, data.project, { rightPanelOpen: Boolean(next) });
      return next;
    });
  }, [data.host, data.project]);

  const localReplyComments = useMemo<LocalReviewComment[]>(() => localReplies.flatMap((reply) => {
    const thread = discussionThreads.find((candidate) => `gerrit:${candidate.id}` === reply.key);
    const anchor = thread ? threadAnchor(thread, data.revisionNumber) ?? thread.comments[0] : undefined;
    const latestPublished = thread?.comments.findLast((comment) => !comment.id.startsWith("local-reply-"));
    if (!anchor || !latestPublished) return [];
    return [{
      key: reply.key,
      path: anchor.path,
      message: reply.message,
      range: commentRange(anchor),
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
    setRelationPanelOpen(false);
    setActiveThreadKey(null);
    setScopeDraft(null);
    setCommentScope((current) => {
      const next = current === path ? null : path;
      saveProjectUiSettings(data.host, data.project, { rightPanelOpen: Boolean(next) });
      return next;
    });
  }, [data.host, data.project]);

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
    for (const comment of combinedReviewComments) {
      const file = files.find((candidate) => candidate.name === comment.path);
      comments[comment.path] = [...(comments[comment.path] ?? []), commentInput(comment, file)];
    }
    const input: { message?: string; labels?: Record<string, number>; comments?: Record<string, GerritCommentInput[]> } = {};
    if (reviewMessage.trim()) input.message = reviewMessage.trim();
    if (codeReview) input.labels = { "Code-Review": Number(codeReview) };
    if (Object.keys(comments).length) input.comments = comments;
    return reviewCommand(sshHost.trim() || data.host, sshPort, sshUser, data.changeNumber, data.revisionNumber, input);
  }, [codeReview, combinedReviewComments, data.changeNumber, data.host, data.revisionNumber, files, reviewMessage, sshHost, sshPort, sshUser]);

  const copyGeneratedReview = useCallback(async () => {
    await navigator.clipboard.writeText(generatedReview);
    window.localStorage.setItem(`gerritdiff:ssh-user:${data.host}`, sshUser.trim());
    window.localStorage.setItem(`gerritdiff:ssh-host:${data.host}`, sshHost.trim() || data.host);
    window.localStorage.setItem(`gerritdiff:ssh-port:${data.host}`, sshPort.trim() || "29418");
    setCopied(true);
  }, [data.host, generatedReview, sshHost, sshPort, sshUser]);

  const openPublishDialog = useCallback(() => {
    setSshUser(window.localStorage.getItem(`gerritdiff:ssh-user:${data.host}`) ?? "");
    setSshHost(window.localStorage.getItem(`gerritdiff:ssh-host:${data.host}`) ?? data.host);
    setSshPort(window.localStorage.getItem(`gerritdiff:ssh-port:${data.host}`) ?? "29418");
    setCopied(false);
    setPublishOpen(true);
  }, [data.host]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>, item: CodeViewItem<CommentMetadata>) => {
    if (!annotation.metadata) return null;
    if (annotation.metadata.kind === "existing") {
      return <ExistingDiscussion annotation={annotation} expanded={false} localReply={localReplies.find((reply) => reply.key === annotation.metadata?.key)} onToggle={toggleActiveDiscussion} onSaveReply={saveLocalReply} onDeleteReply={deleteLocalReply} />;
    }
    return annotation.metadata.kind === "draft"
      ? <DraftComment annotation={annotation} itemId={item.id} onCancel={removeComment} onSave={saveComment} />
      : <SavedComment annotation={annotation} itemId={item.id} onDelete={removeComment} onSelect={toggleCommentSelection} onEdit={editComment} onToggleResolved={toggleCommentResolved} />;
  }, [deleteLocalReply, editComment, localReplies, removeComment, saveComment, saveLocalReply, toggleActiveDiscussion, toggleCommentResolved, toggleCommentSelection]);

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
        fetchFileContent(data.sourceUrl, item.fileDiff.name),
        fetchFileContent(data.sourceUrl, item.fileDiff.prevName ?? item.fileDiff.name, 1),
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
  }, [data.revision, data.sourceUrl, loadingItems]);

  const selectDiscussion = useCallback(async (thread: DiscussionThread) => {
    const key = `gerrit:${thread.id}`;
    setRelationPanelOpen(false);
    setCommentScope(null);
    setActiveThreadKey(key);
    saveProjectUiSettings(data.host, data.project, { rightPanelOpen: true });

    // Thread lives on another patchset: switch revisions and re-select once it loads.
    if (!threadBelongsToPatchset(thread, data.revisionNumber)) {
      const patchset = threadPatchset(thread) ?? thread.comments.at(-1)?.patchSet;
      if (patchset && patchset !== data.revisionNumber) {
        pendingThreadRef.current = { key, patchset };
        onPatchsetChange(patchset);
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
  }, [data.host, data.project, data.revisionNumber, loadFullDiff, onPatchsetChange, pathToChangedId, scrollToItem]);

  useEffect(() => {
    const pending = pendingThreadRef.current;
    if (!pending || pending.patchset !== data.revisionNumber) return;
    pendingThreadRef.current = null;
    const thread = discussionThreads.find((candidate) => `gerrit:${candidate.id}` === pending.key);
    if (thread) void selectDiscussion(thread);
  }, [data.revisionNumber, discussionThreads, selectDiscussion]);

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
      const file = await fetchFileContent(data.sourceUrl, path);
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
  }, [data.revision, data.sourceUrl, loadingItems, pathToChangedId, scrollToItem]);

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
  const activeThread = activeThreadKey ? discussionThreads.find((thread) => `gerrit:${thread.id}` === activeThreadKey) : undefined;
  const activeAnchor = activeThread ? threadAnchor(activeThread, data.revisionNumber) : undefined;
  const activeRange = activeAnchor ? commentRange(activeAnchor) : undefined;
  const activeAnnotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata> | undefined = activeThread && activeAnchor && activeRange
    ? activeAnchor.path === "/COMMIT_MSG"
      ? {
          lineNumber: activeRange.end,
          metadata: { kind: "existing", key: `gerrit:${activeThread.id}`, range: activeRange, textRange: commentTextRange(activeAnchor), thread: activeThread },
        }
      : {
          side: activeRange.side ?? "additions",
          lineNumber: activeRange.end,
          metadata: { kind: "existing", key: `gerrit:${activeThread.id}`, range: activeRange, textRange: commentTextRange(activeAnchor), thread: activeThread },
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
            key: `gerrit:${activeThread.id}`,
            range: commentRange(activeThread.comments[0]),
            thread: activeThread,
          },
        }
      : undefined);

  const discussionPanelVisible = commentScope !== null || Boolean(activePanelAnnotation);
  const sidePanelVisible = relationPanelOpen || discussionPanelVisible;

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
        {sidebarMode === "repository" && <RepositoryBrowser changedFiles={files} sourceUrl={data.sourceUrl} onOpenFile={openRepositoryFile} />}
        {sidebarMode === "discussion" && <DiscussionSidebar threads={discussionThreads} revisionNumber={data.revisionNumber} onSelect={(thread) => void selectDiscussion(thread)} />}
        {sidebarMode === "repository" && (
          <form className="known-path-form" onSubmit={(event) => { event.preventDefault(); const path = knownPath.trim().replace(/^\/+/, ""); if (path) void openRepositoryFile(path); }}>
            <input value={knownPath} onChange={(event) => setKnownPath(event.target.value)} placeholder="Open a known path…" />
            <button type="submit" disabled={!knownPath.trim()}>Open</button>
          </form>
        )}
        <div className="sidebar-summary">
          <span><i className="dot add-dot" /> {data.insertions} additions</span>
          <span><i className="dot del-dot" /> {data.deletions} deletions</span>
        </div>
      </aside>

      <section className="change-main pierre-main">
        <div className="change-header">
          <div className="change-title-row">
            <div className="change-kicker">
              <span className={`change-status ${data.status.toLowerCase()}`}>{data.status}</span>
              <span>{data.project}</span><span>/</span><span>change {data.changeNumber}</span>
            </div>
            <h1 title={data.subject}>{data.subject}</h1>
          </div>
          <div className="change-meta">
            <span className="avatar" style={data.owner.avatarUrl ? { backgroundImage: `url(${data.owner.avatarUrl})` } : undefined}>{data.owner.avatarUrl ? null : initials}</span>
            <strong>{data.owner.name}</strong>
            <span>updated {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(data.updated))}</span>
            <span className="separator">•</span>
            <GitBranch size={14} /><code>{data.branch}</code>
            <div className="patchset-picker">
              <span>Patchset</span>
              <select aria-label="Target patchset" value={data.revisionNumber} onChange={(event) => onPatchsetChange(Number(event.target.value))}>
                {data.revisions.map((revision) => <option key={revision.revision} value={revision.number}>{revision.number}{revision.number === data.revisions.at(-1)?.number ? " (latest)" : ""}</option>)}
              </select>
              <small>against</small>
              <select aria-label="Base patchset" value={data.baseRevisionNumber ?? "parent"} onChange={(event) => onBaseChange(event.target.value === "parent" ? undefined : Number(event.target.value))}>
                <option value="parent">Parent</option>
                {data.revisions.filter((revision) => revision.number !== data.revisionNumber).map((revision) => <option key={revision.revision} value={revision.number}>{revision.number}</option>)}
              </select>
            </div>
            <button
              type="button"
              className="relation-chain-button"
              aria-expanded={relationPanelOpen}
              title={`${data.relationChain.length} change${data.relationChain.length === 1 ? "" : "s"} in the relation chain`}
              onClick={() => {
                setCommentScope(null);
                setActiveThreadKey(null);
                setRelationPanelOpen((open) => {
                  const next = !open;
                  saveProjectUiSettings(data.host, data.project, { rightPanelOpen: next });
                  return next;
                });
              }}
            >
              <GitBranch size={12} />
              <span>Relation chain</span>
              <b>{data.relationChain.length}</b>
            </button>
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
          </div>
        </div>
        {repositoryError && <div className="repository-error"><X size={13} /> <span>{repositoryError}</span><button onClick={() => setRepositoryError("")} aria-label="Dismiss"><X size={12} /></button></div>}
        <div className="diff-toolbar pierre-toolbar">
          <span><strong>{files.length}</strong> files changed</span>
          <span className="comment-hint"><MessageSquare size={13} /> Select lines or click <b>+</b> in the gutter to comment</span>
          {localCommentCount > 0 && <span className="comment-count">{localCommentCount} local comment{localCommentCount === 1 ? "" : "s"}</span>}
          <button type="button" className="publish-review-button" onClick={openPublishDialog}>
            <Terminal size={13} /> Publish review
          </button>
          <details className="view-settings">
            <summary title="Diff display settings">
              <Settings2 size={14} />
              <span>View</span>
              <ChevronDown className="view-settings-chevron" size={12} />
            </summary>
            <div className="view-settings-menu">
              <div className="view-settings-row view-layout-setting">
                <span>Layout</span>
                <div>
                  <button type="button" className={diffStyle === "split" ? "active" : ""} aria-pressed={diffStyle === "split"} onClick={() => { setDiffStyle("split"); saveProjectUiSettings(data.host, data.project, { diffStyle: "split" }); }}><Columns2 size={13} /> Side by side</button>
                  <button type="button" className={diffStyle === "unified" ? "active" : ""} aria-pressed={diffStyle === "unified"} onClick={() => { setDiffStyle("unified"); saveProjectUiSettings(data.host, data.project, { diffStyle: "unified" }); }}><Rows3 size={13} /> Unified</button>
                </div>
              </div>
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
        </WorkerPoolContextProvider>
        {codeTextSelection && (
          <button
            type="button"
            className="text-selection-comment"
            style={{ top: codeTextSelection.top, left: codeTextSelection.left }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => createDraft(codeTextSelection.range, codeTextSelection.itemId, codeTextSelection.textRange)}
          >
            <MessageSquare size={13} /> Comment
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
            <button type="button" onClick={() => { setRelationPanelOpen(false); setCommentScope(null); setActiveThreadKey(null); saveProjectUiSettings(data.host, data.project, { rightPanelOpen: false }); }} aria-label="Close side panel"><X size={15} /></button>
          </div>
          <div className={`discussion-panel-body${commentScope && !relationPanelOpen ? " patchset-discussion-list" : ""}`}>
            {relationPanelOpen ? <RelationChainPanel relations={data.relationChain} /> : null}
            {!relationPanelOpen && commentScope ? scopeThreads.map((thread) => {
              const range = commentRange(thread.comments[0]);
              const annotation: LineAnnotation<CommentMetadata> = {
                lineNumber: 0,
                metadata: { kind: "existing", key: `gerrit:${thread.id}`, range, thread },
              };
              return (
                <ExistingDiscussion
                  key={thread.id}
                  annotation={annotation}
                  expanded
                  localReply={localReplies.find((reply) => reply.key === `gerrit:${thread.id}`)}
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
                onToggle={() => setActiveThreadKey(null)}
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
            <p>The command sends Gerrit a <code>ReviewInput</code> JSON document on stdin, including local inline comments and replies. Comments are keyed by file path; <code>/PATCHSET_LEVEL</code> is Gerrit&rsquo;s reserved path for change-wide comments that aren&rsquo;t attached to a file, and <code>/COMMIT_MSG</code> targets the commit message.</p>
          </section>
        </div>
      )}
    </div>
  );
}
