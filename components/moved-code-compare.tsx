"use client";

import { type CodeViewItem, type CodeViewOptions, type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { ArrowRight, ChevronDown, ChevronUp, FileText, LoaderCircle, Search, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCodeViewDiffOptions, textMatchRanges, updateWhitespaceMarkers } from "@/lib/code-view";
import type { GerritDiffTheme } from "@/lib/theme";

export type FileSnapshotOption = {
  path: string;
  content?: string;
  score: number;
};

type SnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string };

type SearchMatch = { side: "old" | "new"; lineNumber: number }; 

const SEARCH_HIGHLIGHT_NAME = "gerrit-search-result";
const ACTIVE_SEARCH_HIGHLIGHT_NAME = "gerrit-search-result-active";

async function fetchSnapshot(sourceUrl: string, path: string, parent: boolean) {
  const query = new URLSearchParams({ url: sourceUrl, path });
  if (parent) query.set("parent", "1");
  const response = await fetch(`/api/repository/content?${query}`);
  const body = await response.json() as { exists: boolean; binary?: boolean; content?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Couldn’t load ${path}.`);
  if (!body.exists) throw new Error(`${path} does not exist in this revision.`);
  if (body.binary) throw new Error(`${path} is binary and cannot be displayed.`);
  return body.content ?? "";
}

function preferredPath(options: FileSnapshotOption[]) {
  return options.toSorted((left, right) => right.score - left.score)[0]?.path ?? "";
}

function SnapshotPane({
  label,
  tone,
  revisionLabel,
  options,
  path,
  state,
  theme,
  tabSize,
  showWhitespace,
  fileDiff,
  viewerRef,
  onPostRender,
  onPathChange,
}: {
  label: string;
  tone: "deletion" | "addition";
  revisionLabel: string;
  options: FileSnapshotOption[];
  path: string;
  state: SnapshotState;
  theme: GerritDiffTheme;
  tabSize: number;
  showWhitespace: boolean;
  fileDiff?: FileDiffMetadata;
  viewerRef: RefObject<CodeViewHandle<unknown> | null>;
  onPostRender(): void;
  onPathChange(path: string): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemId = `${label}:${path}`;
  const codeViewOptions = useMemo<CodeViewOptions<unknown>>(() => {
    const visibleSide = tone === "deletion" ? "deletions" : "additions";
    const hiddenSide = tone === "deletion" ? "additions" : "deletions";
    return {
      ...createCodeViewDiffOptions<unknown>({
        theme,
        diffStyle: "split",
        tabSize,
        unsafeCSS: `
          ::highlight(${SEARCH_HIGHLIGHT_NAME}) { color: #17131f; background-color: rgba(255, 214, 72, .72); }
          ::highlight(${ACTIVE_SEARCH_HIGHLIGHT_NAME}) { color: #17131f; background-color: #ff9f43; text-decoration: underline 2px #7a3d00; text-underline-offset: 2px; }
          [data-diff-type="split"][data-overflow="scroll"] { display: block; }
          [data-diff-type="split"] [data-${hiddenSide}] { display: none; }
          [data-diff-type="split"] [data-${visibleSide}] { border: 0; }
        `,
      }),
      layout: { paddingTop: 0, gap: 0, paddingBottom: 0 },
      disableFileHeader: true,
      expandUnchanged: true,
      lineHoverHighlight: "number",
      enableLineSelection: false,
      onPostRender(node) {
        updateWhitespaceMarkers(node, showWhitespace);
        requestAnimationFrame(onPostRender);
      },
    };
  }, [onPostRender, showWhitespace, tabSize, theme, tone]);
  const items = useMemo<CodeViewItem<unknown>[]>(() => fileDiff ? [{
    id: itemId,
    type: "diff",
    fileDiff,
  }] : [], [fileDiff, itemId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (!viewer || !item || item.type !== "diff" || !fileDiff || item.fileDiff === fileDiff) return;
    const scrollTop = containerRef.current?.scrollTop;
    const scrollLeft = containerRef.current?.scrollLeft;
    item.fileDiff = fileDiff;
    item.version = (item.version ?? 0) + 1;
    viewer.updateItem(item);
    if (scrollTop === undefined || scrollLeft === undefined) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      containerRef.current?.scrollTo({ top: scrollTop, left: scrollLeft });
    }));
  }, [fileDiff, itemId, viewerRef]);

  useEffect(() => {
    for (const rendered of viewerRef.current?.getInstance()?.getRenderedItems() ?? []) {
      const root = rendered.element.shadowRoot;
      if (root) updateWhitespaceMarkers(root, showWhitespace);
    }
  }, [showWhitespace, viewerRef]);

  return (
    <section className={`moved-code-pane is-${tone}`}>
      <header>
        <span>{label}</span>
        <strong>{revisionLabel}</strong>
        <select aria-label={`${label} file`} value={path} onChange={(event) => onPathChange(event.target.value)}>
          {options.map((option) => <option key={option.path} value={option.path}>{option.path}</option>)}
        </select>
      </header>
      {state.status === "loading" && <div className="moved-code-state"><LoaderCircle className="spinner" size={17} /><span>Loading {path}…</span></div>}
      {state.status === "error" && <div className="moved-code-state is-error"><FileText size={17} /><span>{state.message}</span></div>}
      {state.status === "ready" && !fileDiff && <div className="moved-code-state"><LoaderCircle className="spinner" size={17} /><span>Comparing files…</span></div>}
      {state.status === "ready" && fileDiff && (
        <CodeView<unknown>
          ref={viewerRef}
          containerRef={containerRef}
          key={`${revisionLabel}:${path}`}
          initialItems={items}
          className="pierre-code-view moved-code-view"
          options={codeViewOptions}
        />
      )}
    </section>
  );
}

export function MovedCodeCompare({
  sourceUrl,
  oldFiles,
  newFiles,
  baseLabel,
  targetLabel,
  theme,
  tabSize,
  showWhitespace,
  ignoreIndentation,
  onClose,
}: {
  sourceUrl: string;
  oldFiles: FileSnapshotOption[];
  newFiles: FileSnapshotOption[];
  baseLabel: string;
  targetLabel: string;
  theme: GerritDiffTheme;
  tabSize: number;
  showWhitespace: boolean;
  ignoreIndentation: boolean;
  onClose(): void;
}) {
  const oldViewerRef = useRef<CodeViewHandle<unknown> | null>(null);
  const newViewerRef = useRef<CodeViewHandle<unknown> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [oldPath, setOldPath] = useState(() => preferredPath(oldFiles));
  const [newPath, setNewPath] = useState(() => preferredPath(newFiles));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [loadedOld, setLoadedOld] = useState<{ path: string; state: SnapshotState } | null>(null);
  const [loadedNew, setLoadedNew] = useState<{ path: string; state: SnapshotState } | null>(null);
  const oldOption = oldFiles.find((file) => file.path === oldPath);
  const newOption = newFiles.find((file) => file.path === newPath);
  const oldState: SnapshotState = oldOption?.content !== undefined
    ? { status: "ready", content: oldOption.content }
    : loadedOld?.path === oldPath ? loadedOld.state : { status: "loading" };
  const newState: SnapshotState = newOption?.content !== undefined
    ? { status: "ready", content: newOption.content }
    : loadedNew?.path === newPath ? loadedNew.state : { status: "loading" };
  const oldContent = oldState.status === "ready" ? oldState.content : undefined;
  const newContent = newState.status === "ready" ? newState.content : undefined;
  const searchMatches = useMemo<SearchMatch[]>(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    return ([
      ["old", oldContent],
      ["new", newContent],
    ] as const).flatMap(([side, content]) => (content ?? "").split(/\r?\n/).flatMap((line, index) =>
      line.toLocaleLowerCase().includes(query) ? [{ side, lineNumber: index + 1 }] : [],
    ));
  }, [newContent, oldContent, searchQuery]);
  const crossFileDiff = useMemo(() => oldContent !== undefined && newContent !== undefined
    ? parseDiffFromFile(
        { name: oldPath, contents: oldContent, cacheKey: `${baseLabel}:${oldPath}:ignore-indent-${ignoreIndentation}` },
        { name: newPath, contents: newContent, cacheKey: `${targetLabel}:${newPath}:ignore-indent-${ignoreIndentation}` },
        { ignoreWhitespace: ignoreIndentation },
        true,
      )
    : undefined,
  [baseLabel, ignoreIndentation, newContent, newPath, oldContent, oldPath, targetLabel]);

  const refreshSearchHighlights = useCallback(() => {
    const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void } }).highlights;
    const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const query = searchQuery.trim();
    const activeMatch = searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    if (!registry || !HighlightConstructor || !searchOpen || !query || !activeMatch) {
      registry?.delete(SEARCH_HIGHLIGHT_NAME);
      registry?.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
      return;
    }
    const ranges: Range[] = [];
    const activeRanges: Range[] = [];
    const panes = [
      { side: "old" as const, viewer: oldViewerRef.current, diffSide: "deletions" },
      { side: "new" as const, viewer: newViewerRef.current, diffSide: "additions" },
    ];
    for (const pane of panes) {
      for (const rendered of pane.viewer?.getInstance()?.getRenderedItems() ?? []) {
        const root = rendered.element.shadowRoot;
        if (!root) continue;
        for (const line of root.querySelectorAll<HTMLElement>(`[data-${pane.diffSide}] [data-line]`)) {
          const lineNumber = Number(line.dataset.line);
          if (!searchMatches.some((match) => match.side === pane.side && match.lineNumber === lineNumber)) continue;
          const lineRanges = textMatchRanges(line, query);
          if (activeMatch.side === pane.side && activeMatch.lineNumber === lineNumber) activeRanges.push(...lineRanges);
          else ranges.push(...lineRanges);
        }
      }
    }
    if (ranges.length) registry.set(SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...ranges));
    else registry.delete(SEARCH_HIGHLIGHT_NAME);
    if (activeRanges.length) registry.set(ACTIVE_SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...activeRanges));
    else registry.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
  }, [searchIndex, searchMatches, searchOpen, searchQuery]);

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, []);

  useEffect(() => {
    if (!searchOpen || !searchMatches.length) return;
    const match = searchMatches[Math.min(searchIndex, searchMatches.length - 1)];
    const viewer = match.side === "old" ? oldViewerRef.current : newViewerRef.current;
    viewer?.scrollTo({
      type: "line",
      id: `${match.side === "old" ? "Before" : "After"}:${match.side === "old" ? oldPath : newPath}`,
      lineNumber: match.lineNumber,
      side: match.side === "old" ? "deletions" : "additions",
      align: "center",
    });
    const frame = requestAnimationFrame(() => requestAnimationFrame(refreshSearchHighlights));
    return () => cancelAnimationFrame(frame);
  }, [newPath, oldPath, refreshSearchHighlights, searchIndex, searchMatches, searchOpen]);

  useEffect(() => {
    if (searchOpen) refreshSearchHighlights();
    else {
      const registry = (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights;
      registry?.delete(SEARCH_HIGHLIGHT_NAME);
      registry?.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
    }
    return () => {
      const registry = (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights;
      registry?.delete(SEARCH_HIGHLIGHT_NAME);
      registry?.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME);
    };
  }, [refreshSearchHighlights, searchOpen]);

  useEffect(() => {
    if (!oldOption || oldOption.content !== undefined) return;
    let active = true;
    void fetchSnapshot(sourceUrl, oldPath, true)
      .then((content) => { if (active) setLoadedOld({ path: oldPath, state: { status: "ready", content } }); })
      .catch((error) => { if (active) setLoadedOld({ path: oldPath, state: { status: "error", message: error instanceof Error ? error.message : `Couldn’t load ${oldPath}.` } }); });
    return () => { active = false; };
  }, [oldOption, oldPath, sourceUrl]);

  useEffect(() => {
    if (!newOption || newOption.content !== undefined) return;
    let active = true;
    void fetchSnapshot(sourceUrl, newPath, false)
      .then((content) => { if (active) setLoadedNew({ path: newPath, state: { status: "ready", content } }); })
      .catch((error) => { if (active) setLoadedNew({ path: newPath, state: { status: "error", message: error instanceof Error ? error.message : `Couldn’t load ${newPath}.` } }); });
    return () => { active = false; };
  }, [newOption, newPath, sourceUrl]);

  return (
    <div className="moved-code-compare">
      <div className="moved-code-intro">
        <span>Moved code comparison</span>
        <p>Choose an old file and a new file. Each side scrolls independently.</p>
        {searchOpen && (
          <form
            className="code-search moved-code-search"
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
              aria-label="Find in compared files"
              placeholder="Find in compared files"
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
        <button type="button" onClick={onClose}><X size={13} /> Close</button>
      </div>
      <div className="moved-code-grid">
        <SnapshotPane key={`before:${oldPath}:${newPath}`} label="Before" tone="deletion" revisionLabel={baseLabel} options={oldFiles} path={oldPath} state={oldState} theme={theme} tabSize={tabSize} showWhitespace={showWhitespace} fileDiff={crossFileDiff} viewerRef={oldViewerRef} onPostRender={refreshSearchHighlights} onPathChange={setOldPath} />
        <span className="moved-code-direction" aria-hidden="true"><ArrowRight size={14} /></span>
        <SnapshotPane key={`after:${oldPath}:${newPath}`} label="After" tone="addition" revisionLabel={targetLabel} options={newFiles} path={newPath} state={newState} theme={theme} tabSize={tabSize} showWhitespace={showWhitespace} fileDiff={crossFileDiff} viewerRef={newViewerRef} onPostRender={refreshSearchHighlights} onPathChange={setNewPath} />
      </div>
    </div>
  );
}
