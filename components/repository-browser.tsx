"use client";

import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileTreeBatchOperation, GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { FolderGit2, LoaderCircle, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PENDING_NAME = ".__clanker_pending__";

function pendingPath(directory: string) {
  return directory ? `${directory}/${PENDING_NAME}` : PENDING_NAME;
}

function gitStatusFor(file: FileDiffMetadata): GitStatus {
  if (file.type === "new") return "added";
  if (file.type === "deleted") return "deleted";
  if (file.type === "rename-pure" || file.type === "rename-changed") return "renamed";
  return "modified";
}

type TreeEntry = { name: string; path: string; type: "directory" | "file" };
type TreeResponse = { available: boolean; entries: TreeEntry[]; error?: string };

export function RepositoryBrowser({
  changedFiles,
  sourceUrl,
  onOpenFile,
}: {
  changedFiles: FileDiffMetadata[];
  sourceUrl: string;
  onOpenFile(path: string): void;
}) {
  const selectionHandlerRef = useRef<(paths: readonly string[]) => void>(() => undefined);
  const directoriesRef = useRef(new Set<string>());
  const loadedRef = useRef(new Set<string>());
  const loadingRef = useRef(new Set<string>());
  const knownPathsRef = useRef(new Set<string>([PENDING_NAME]));
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState("Loading repository tree…");

  const gitStatus = useMemo<GitStatusEntry[]>(
    () => changedFiles.map((file) => ({ path: file.name, status: gitStatusFor(file) })),
    [changedFiles],
  );

  const handleSelectionProxy = useCallback((selectedPaths: readonly string[]) => {
    selectionHandlerRef.current(selectedPaths);
  }, []);

  const { model } = useFileTree({
    paths: [PENDING_NAME],
    gitStatus,
    icons: { set: "standard", colored: false },
    flattenEmptyDirectories: false,
    initialExpansion: "open",
    initialVisibleRowCount: 30,
    itemHeight: 25,
    onSelectionChange: handleSelectionProxy,
    search: true,
    stickyFolders: true,
    unsafeCSS: `
      [data-file-tree-search-container] { margin: 8px; }
      [data-file-tree-virtualized-scroll='true'] { padding-inline: 4px; }
      [data-item-contains-git-change='true'] > [data-item-section='git'] { display: none; }
      [data-item-path$='${PENDING_NAME}'] { display: none; }
    `,
  });

  const loadDirectory = useCallback(async (directory: string) => {
    if (loadedRef.current.has(directory) || loadingRef.current.has(directory)) return;
    loadingRef.current.add(directory);
    try {
      const response = await fetch(`/api/repository/tree?url=${encodeURIComponent(sourceUrl)}&path=${encodeURIComponent(directory)}`);
      const body = await response.json() as TreeResponse;
      if (!response.ok) {
        setState(response.status === 501 ? "unavailable" : "error");
        setMessage(body.error ?? "Couldn’t load the repository tree.");
        return;
      }

      const operations: FileTreeBatchOperation[] = [];
      const placeholder = pendingPath(directory);
      const nextPaths: string[] = [];
      for (const entry of body.entries) {
        if (entry.type === "directory") {
          directoriesRef.current.add(entry.path);
          nextPaths.push(pendingPath(entry.path));
        } else {
          nextPaths.push(entry.path);
        }
      }
      for (const path of nextPaths) {
        if (!knownPathsRef.current.has(path)) {
          knownPathsRef.current.add(path);
          operations.push({ type: "add", path });
        }
      }
      if (body.entries.length > 0 && knownPathsRef.current.has(placeholder)) {
        knownPathsRef.current.delete(placeholder);
        operations.push({ type: "remove", path: placeholder });
      }
      if (operations.length) model.batch(operations);
      loadedRef.current.add(directory);
      const directoryItem = directory ? model.getItem(directory) : null;
      if (directoryItem && "expand" in directoryItem) directoryItem.expand();
      setState("ready");
      setMessage("");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Couldn’t load the repository tree.");
    } finally {
      loadingRef.current.delete(directory);
    }
  }, [model, sourceUrl]);

  useEffect(() => {
    selectionHandlerRef.current = (selectedPaths) => {
      if (selectedPaths.length !== 1) return;
      const path = selectedPaths[0];
      if (path.endsWith(PENDING_NAME)) return;
      if (directoriesRef.current.has(path)) void loadDirectory(path);
      else onOpenFile(path);
    };
    queueMicrotask(() => void loadDirectory(""));
  }, [loadDirectory, onOpenFile]);

  return (
    <div className="repository-browser">
      {state !== "ready" && (
        <div className={`repository-state ${state}`}>
          {state === "loading" ? <LoaderCircle className="spinner" size={15} /> : <TriangleAlert size={15} />}
          <span>{message}</span>
        </div>
      )}
      {state === "unavailable" && (
        <div className="repository-fallback"><FolderGit2 size={17} /><p>You can still open a known path using the field below.</p></div>
      )}
      <FileTree model={model} className="pierre-tree" />
    </div>
  );
}
