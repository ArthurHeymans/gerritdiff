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
import { ChevronDown, FileText, GitBranch, LoaderCircle, MessageSquare, Send, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { RepositoryBrowser } from "@/components/repository-browser";
import type { ChangeData } from "@/lib/types";
import type { ClankerTheme } from "@/lib/theme";

type CommentMetadata =
  | { kind: "draft"; key: string; message: string; range: SelectedLineRange }
  | { kind: "saved"; key: string; author: string; message: string; range: SelectedLineRange };

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
  const [message, setMessage] = useState(annotation.metadata?.message ?? "");
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

export function ChangeReview({ data, theme }: { data: ChangeData; theme: ClankerTheme }) {
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const activeDraftRef = useRef<ActiveDraft | null>(null);
  const nextCommentRef = useRef(1);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [commentCount, setCommentCount] = useState(0);
  const [sidebarMode, setSidebarMode] = useState<"changed" | "repository">("changed");
  const [knownPath, setKnownPath] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [loadingItems, setLoadingItems] = useState<ReadonlySet<string>>(() => new Set());

  const files = useMemo(
    () => parsePatchFiles(data.patch, `${data.host}-${data.changeNumber}-${data.revisionNumber}`, true).flatMap((parsed) => parsed.files),
    [data.changeNumber, data.host, data.patch, data.revisionNumber],
  );
  const initialItems = useMemo<CodeViewItem<CommentMetadata>[]>(
    () => files.map((fileDiff, index) => ({ id: `file-${index}`, type: "diff", fileDiff })),
    [files],
  );
  const pathToChangedId = useMemo(
    () => new Map(files.map((file, index) => [file.name, `file-${index}`])),
    [files],
  );

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
    diffStyle: "unified",
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
  }), [createDraft, theme]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<CommentMetadata> | LineAnnotation<CommentMetadata>, item: CodeViewItem<CommentMetadata>) => {
    if (!("side" in annotation) || item.type !== "diff" || !annotation.metadata) return null;
    return annotation.metadata.kind === "draft"
      ? <DraftComment annotation={annotation} itemId={item.id} onCancel={removeComment} onSave={saveComment} />
      : <SavedComment annotation={annotation} itemId={item.id} onDelete={removeComment} onSelect={toggleCommentSelection} />;
  }, [removeComment, saveComment, toggleCommentSelection]);

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
        </div>
        {sidebarMode === "changed"
          ? <ReviewFileTree files={files} onSelect={scrollToItem} />
          : <RepositoryBrowser changedFiles={files} sourceUrl={data.sourceUrl} onOpenFile={openRepositoryFile} />}
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
