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
  areSelectionsEqual,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Check, ChevronDown, CircleCheck, Columns2, FileText, GitBranch, LoaderCircle, MessageSquare, Quote, Reply, Rows3, Send, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RepositoryBrowser } from "@/components/repository-browser";
import type { ChangeData, GerritComment } from "@/lib/types";
import type { GerritDiffTheme } from "@/lib/theme";

type DiscussionThread = { id: string; path: string; comments: GerritComment[] };

type CommentMetadata =
  | { kind: "draft"; key: string; message: string; range: SelectedLineRange }
  | { kind: "saved"; key: string; author: string; message: string; range: SelectedLineRange }
  | { kind: "existing"; key: string; range: SelectedLineRange; thread: DiscussionThread };

type ActiveDraft = { itemId: string; key: string };

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

function commentRange(comment: GerritComment): SelectedLineRange {
  const side = comment.side === "PARENT" ? "deletions" : "additions";
  return { start: comment.range?.startLine ?? comment.line ?? 0, end: comment.range?.endLine ?? comment.line ?? 0, side, endSide: side };
}

function DraftComment({
  annotation,
  itemId,
  onCancel,
  onSave,
}: {
  annotation: DiffLineAnnotation<CommentMetadata>;
  itemId: string;
  onCancel(itemId: string, key: string): void;
  onSave(itemId: string, key: string, message: string): void;
}) {
  const [message, setMessage] = useState(annotation.metadata?.kind === "draft" ? annotation.metadata.message : "");
  const key = annotation.metadata?.key ?? "";
  const trimmed = message.trim();

  return (
    <form
      className="comment-card comment-draft"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave(itemId, key, trimmed);
      }}
    >
      <div className="comment-avatar">You</div>
      <div className="comment-compose">
        <textarea
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel(itemId, key);
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && trimmed) onSave(itemId, key, trimmed);
          }}
          placeholder="Add a comment…"
          rows={2}
        />
        <div className="comment-actions">
          <span>Ctrl ↵ to submit</span>
          <button type="button" className="comment-cancel" onClick={() => onCancel(itemId, key)}><X size={14} /> Cancel</button>
          <button type="submit" disabled={!trimmed}><Send size={13} /> Add comment</button>
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
}: {
  annotation: DiffLineAnnotation<CommentMetadata>;
  itemId: string;
  onDelete(itemId: string, key: string): void;
  onSelect(selection: CodeViewLineSelection): void;
}) {
  const metadata = annotation.metadata;
  if (!metadata || metadata.kind !== "saved") return null;
  return (
    <div className="comment-card saved-comment" onClick={() => onSelect({ id: itemId, range: metadata.range })}>
      <div className="comment-avatar">{metadata.author.slice(0, 2).toUpperCase()}</div>
      <div className="saved-comment-body">
        <div><strong>{metadata.author}</strong><span>just now</span></div>
        <p>{metadata.message}</p>
      </div>
      <button onClick={(event) => { event.stopPropagation(); onDelete(itemId, metadata.key); }} aria-label="Delete comment"><Trash2 size={14} /></button>
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

function ExistingDiscussion({ annotation, itemId, onReply }: { annotation: DiffLineAnnotation<CommentMetadata>; itemId: string; onReply(itemId: string, key: string, message: string, resolve: boolean): void }) {
  const metadata = annotation.metadata;
  const [draft, setDraft] = useState<string | null>(null);
  if (!metadata || metadata.kind !== "existing") return null;
  const latest = metadata.thread.comments.at(-1);
  const unresolved = latest?.unresolved ?? false;
  const submit = (message: string, resolve = false) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    onReply(itemId, metadata.key, trimmed, resolve);
    setDraft(null);
  };
  return (
    <div className="comment-card existing-discussion">
      <div className="existing-thread-head">
        <strong>{metadata.thread.comments.length === 1 ? "Review comment" : `${metadata.thread.comments.length} comment discussion`}</strong>
        <span className={unresolved ? "unresolved" : "resolved"}>{unresolved ? "Unresolved" : "Resolved"}</span>
      </div>
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
      <div className="discussion-actions">
        <button onClick={() => setDraft("")}><Reply size={12} /> Reply</button>
        <button onClick={() => setDraft(`${(latest?.message ?? "").split("\n").map((line) => `> ${line}`).join("\n")}\n\n`)}><Quote size={12} /> Quote</button>
        <button onClick={() => submit("Ack", true)}><Check size={12} /> Ack</button>
        <button onClick={() => submit("Done", true)}><CircleCheck size={12} /> Done</button>
      </div>
      {draft !== null && (
        <form className="discussion-reply" onSubmit={(event) => { event.preventDefault(); submit(draft); }}>
          <textarea autoFocus rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a reply…" />
          <div><span>Saved locally; Gerrit sign-in is required to publish.</span><button type="button" onClick={() => setDraft(null)}>Cancel</button><button type="submit" disabled={!draft.trim()}>Add reply</button></div>
        </form>
      )}
    </div>
  );
}

function DiscussionSidebar({ threads, onSelect }: { threads: DiscussionThread[]; onSelect(thread: DiscussionThread): void }) {
  if (!threads.length) return <div className="discussion-empty"><MessageSquare size={20} /><strong>No discussion yet</strong><span>Published Gerrit comments will appear here.</span></div>;
  return (
    <div className="discussion-sidebar">
      {threads.map((thread) => {
        const latest = thread.comments.at(-1);
        return (
          <button key={thread.id} onClick={() => onSelect(thread)}>
            <span className="discussion-path">{thread.path === "/PATCHSET_LEVEL" ? "Patchset" : thread.path}</span>
            <strong>{thread.comments[0]?.author.name}</strong>
            <p>{commentSummary(thread.comments[0]?.message ?? "")}</p>
            <span className="discussion-meta">{thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"} · Patchset {thread.comments[0]?.patchSet}{latest?.unresolved ? " · Unresolved" : ""}</span>
          </button>
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

export function ChangeReview({ data, theme }: { data: ChangeData; theme: GerritDiffTheme }) {
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const activeDraftRef = useRef<ActiveDraft | null>(null);
  const nextCommentRef = useRef(1);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [commentCount, setCommentCount] = useState(0);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const [sidebarMode, setSidebarMode] = useState<"changed" | "repository" | "discussion">("changed");
  const [knownPath, setKnownPath] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingItems, setLoadingItems] = useState<ReadonlySet<string>>(() => new Set());

  const files = useMemo(
    () => parsePatchFiles(data.patch, `${data.host}-${data.changeNumber}-${data.revisionNumber}`, true).flatMap((parsed) => parsed.files),
    [data.changeNumber, data.host, data.patch, data.revisionNumber],
  );
  const [discussionThreads, setDiscussionThreads] = useState(() => buildDiscussionThreads(data.comments));
  const initialItems = useMemo<CodeViewItem<CommentMetadata>[]>(
    () => files.map((fileDiff, index) => {
      const annotations: DiffLineAnnotation<CommentMetadata>[] = [];
      for (const thread of discussionThreads) {
        const anchor = threadAnchor(thread, data.revisionNumber);
        if (!anchor || anchor.path !== fileDiff.name) continue;
        const range = commentRange(anchor);
        annotations.push({
          side: range.side ?? "additions",
          lineNumber: range.end,
          metadata: { kind: "existing", key: `gerrit:${thread.id}`, range, thread },
        });
      }
      return { id: `file-${index}`, type: "diff", fileDiff, annotations };
    }),
    [data.revisionNumber, discussionThreads, files],
  );
  const pathToChangedId = useMemo(
    () => new Map(files.map((file, index) => [file.name, `file-${index}`])),
    [files],
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateForViewport = (matches: boolean) => setDiffStyle(matches ? "unified" : "split");
    const handleChange = (event: MediaQueryListEvent) => updateForViewport(event.matches);
    updateForViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const updateDiffItem = useCallback((itemId: string, update: (item: CodeViewDiffItem<CommentMetadata>) => boolean) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (!viewer || !item || !isDiffItem(item) || !update(item)) return undefined;
    item.version = nextVersion(item);
    return viewer.updateItem(item) ? item : undefined;
  }, []);

  const removeComment = useCallback((itemId: string, key: string) => {
    let removedSaved = false;
    updateDiffItem(itemId, (item) => {
      const target = item.annotations?.find((annotation) => annotation.metadata?.key === key);
      removedSaved = target?.metadata?.kind === "saved";
      const annotations = item.annotations?.filter((annotation) => annotation.metadata?.key !== key) ?? [];
      if (annotations.length === (item.annotations?.length ?? 0)) return false;
      item.annotations = annotations;
      return true;
    });
    if (removedSaved) setCommentCount((count) => Math.max(0, count - 1));
    if (activeDraftRef.current?.key === key) activeDraftRef.current = null;
    setSelectedLines(null);
  }, [updateDiffItem]);

  const saveComment = useCallback((itemId: string, key: string, message: string) => {
    const updated = updateDiffItem(itemId, (item) => {
      if (!item.annotations) return false;
      item.annotations = item.annotations.map((annotation) =>
        annotation.metadata?.key === key
          ? { ...annotation, metadata: { ...annotation.metadata, kind: "saved" as const, author: "You", message } }
          : annotation,
      );
      return true;
    });
    if (updated) {
      activeDraftRef.current = null;
      setCommentCount((count) => count + 1);
      setSelectedLines(null);
    }
  }, [updateDiffItem]);

  const createDraft = useCallback((range: SelectedLineRange, itemId: string) => {
    const side = range.endSide ?? range.side;
    if (!side) return;
    const key = `draft-${nextCommentRef.current++}`;
    const previous = activeDraftRef.current;
    if (previous && previous.itemId !== itemId) removeComment(previous.itemId, previous.key);
    const annotation: DiffLineAnnotation<CommentMetadata> = {
      side,
      lineNumber: range.end,
      metadata: { kind: "draft", key, message: "", range },
    };
    const updated = updateDiffItem(itemId, (item) => {
      item.annotations = [...(item.annotations ?? []).filter((entry) => entry.metadata?.kind !== "draft"), annotation];
      return true;
    });
    if (updated) activeDraftRef.current = { itemId, key };
  }, [removeComment, updateDiffItem]);

  const toggleCollapsed = useCallback((itemId: string) => {
    updateDiffItem(itemId, (item) => { item.collapsed = !item.collapsed; return true; });
  }, [updateDiffItem]);

  const toggleCommentSelection = useCallback((selection: CodeViewLineSelection) => {
    setSelectedLines((current) => current?.id === selection.id && areSelectionsEqual(current.range, selection.range) ? null : selection);
  }, []);

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
    onGutterUtilityClick(range, context) {
      if (context.item.type === "diff") createDraft(range, context.item.id);
    },
  }), [createDraft, diffStyle, theme]);

  const addDiscussionReply = useCallback((itemId: string, key: string, message: string, resolve: boolean) => {
    const timestamp = new Date().toISOString();
    let updatedThread: DiscussionThread | undefined;
    updateDiffItem(itemId, (item) => {
      item.annotations = item.annotations?.map((annotation) => {
        const metadata = annotation.metadata;
        if (metadata?.kind !== "existing" || metadata.key !== key) return annotation;
        const latest = metadata.thread.comments.at(-1);
        const anchor = threadAnchor(metadata.thread, data.revisionNumber) ?? metadata.thread.comments[0];
        if (!latest || !anchor) return annotation;
        const reply: GerritComment = {
          id: `local-reply-${nextCommentRef.current++}`,
          path: anchor.path,
          patchSet: data.revisionNumber,
          line: anchor.line,
          side: anchor.side,
          range: anchor.range,
          author: { name: "You" },
          message,
          updated: timestamp,
          unresolved: resolve ? false : latest.unresolved,
          inReplyTo: latest.id,
        };
        updatedThread = { ...metadata.thread, comments: [...metadata.thread.comments, reply] };
        return { ...annotation, metadata: { ...metadata, thread: updatedThread } };
      });
      return Boolean(updatedThread);
    });
    if (updatedThread) {
      const nextThread = updatedThread;
      setDiscussionThreads((threads) => threads.map((thread) => thread.id === nextThread.id ? nextThread : thread));
      setCommentCount((count) => count + 1);
    }
  }, [data.revisionNumber, updateDiffItem]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>, item: CodeViewItem<CommentMetadata>) => {
    if (!("side" in annotation) || item.type !== "diff" || !annotation.metadata) return null;
    if (annotation.metadata.kind === "existing") return <ExistingDiscussion annotation={annotation} itemId={item.id} onReply={addDiscussionReply} />;
    return annotation.metadata.kind === "draft"
      ? <DraftComment annotation={annotation} itemId={item.id} onCancel={removeComment} onSave={saveComment} />
      : <SavedComment annotation={annotation} itemId={item.id} onDelete={removeComment} onSelect={toggleCommentSelection} />;
  }, [addDiscussionReply, removeComment, saveComment, toggleCommentSelection]);

  const renderHeaderPrefix = useCallback((item: CodeViewItem<CommentMetadata>) => {
    if (item.type !== "diff") return null;
    return <CollapseButton disabled={item.fileDiff.splitLineCount === 0 && item.fileDiff.unifiedLineCount === 0} collapsed={item.collapsed} onToggle={() => toggleCollapsed(item.id)} />;
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
    const anchor = threadAnchor(thread, data.revisionNumber);
    const itemId = pathToChangedId.get(anchor?.path ?? thread.path);
    if (!itemId) return;
    if (!anchor) {
      scrollToItem(itemId);
      return;
    }
    await loadFullDiff(itemId);
    const range = commentRange(anchor);
    setSelectedLines({ id: itemId, range });
    viewerRef.current?.scrollTo({ type: "range", id: itemId, range, align: "center", behavior: "smooth" });
  }, [data.revisionNumber, loadFullDiff, pathToChangedId, scrollToItem]);

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
    if (item.type !== "diff" || !item.fileDiff.isPartial) return null;
    const loading = loadingItems.has(item.id);
    return (
      <button className="load-full-file" disabled={loading} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void loadFullDiff(item.id); }}>
        {loading ? <LoaderCircle className="spinner" size={12} /> : <FileText size={12} />}
        {loading ? "Loading…" : "Load full file"}
      </button>
    );
  }, [loadFullDiff, loadingItems]);

  const initials = data.owner.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();

  return (
    <div className="review-layout">
      <aside className="sidebar pierre-sidebar">
        <div className="sidebar-tabs">
          <button className={sidebarMode === "changed" ? "active" : ""} onClick={() => setSidebarMode("changed")}>Changed <b>{files.length}</b></button>
          <button className={sidebarMode === "repository" ? "active" : ""} onClick={() => setSidebarMode("repository")}>Repository</button>
          <button className={sidebarMode === "discussion" ? "active" : ""} onClick={() => setSidebarMode("discussion")}>Discussion <b>{discussionThreads.length}</b></button>
        </div>
        {sidebarMode === "changed" && <ReviewFileTree files={files} onSelect={scrollToItem} />}
        {sidebarMode === "repository" && <RepositoryBrowser changedFiles={files} sourceUrl={data.sourceUrl} onOpenFile={openRepositoryFile} />}
        {sidebarMode === "discussion" && <DiscussionSidebar threads={discussionThreads} onSelect={(thread) => void selectDiscussion(thread)} />}
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
          <div className="change-kicker">
            <span className={`change-status ${data.status.toLowerCase()}`}>{data.status}</span>
            <span>{data.project}</span><span>/</span><span>change {data.changeNumber}</span>
          </div>
          <h1>{data.subject}</h1>
          <div className="change-meta">
            <span className="avatar" style={data.owner.avatarUrl ? { backgroundImage: `url(${data.owner.avatarUrl})` } : undefined}>{data.owner.avatarUrl ? null : initials}</span>
            <strong>{data.owner.name}</strong>
            <span>updated {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(data.updated))}</span>
            <span className="separator">•</span>
            <GitBranch size={14} /><code>{data.branch}</code>
            <span className="patchset">Patchset {data.revisionNumber}</span>
          </div>
        </div>
        {repositoryError && <div className="repository-error"><X size={13} /> <span>{repositoryError}</span><button onClick={() => setRepositoryError("")} aria-label="Dismiss"><X size={12} /></button></div>}
        <div className="diff-toolbar pierre-toolbar">
          <span><strong>{files.length}</strong> files changed</span>
          <span className="comment-hint"><MessageSquare size={13} /> Select lines or click <b>+</b> in the gutter to comment</span>
          {commentCount > 0 && <span className="comment-count">{commentCount} local comment{commentCount === 1 ? "" : "s"}</span>}
          <button
            type="button"
            className="diff-style-toggle"
            title={diffStyle === "split" ? "Switch to unified view" : "Switch to side-by-side view"}
            aria-label={diffStyle === "split" ? "Switch to unified view" : "Switch to side-by-side view"}
            onClick={() => setDiffStyle((current) => current === "split" ? "unified" : "split")}
          >
            {diffStyle === "split" ? <Columns2 size={14} /> : <Rows3 size={14} />}
            <span>{diffStyle === "split" ? "Side by side" : "Unified"}</span>
          </button>
          <span className="summary-add">+{data.insertions}</span>
          <span className="summary-del">−{data.deletions}</span>
        </div>
        <CodeView<CommentMetadata>
          ref={viewerRef}
          initialItems={initialItems}
          className="pierre-code-view"
          options={options}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={renderHeaderPrefix}
          renderHeaderMetadata={renderHeaderMetadata}
        />
      </section>
    </div>
  );
}
