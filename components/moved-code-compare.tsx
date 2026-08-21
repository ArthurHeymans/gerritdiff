"use client";

import { type CodeViewItem, type CodeViewOptions } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { ArrowRight, FileText, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  revisionLabel,
  options,
  path,
  state,
  theme,
  tabSize,
  onPathChange,
}: {
  label: string;
  revisionLabel: string;
  options: FileSnapshotOption[];
  path: string;
  state: SnapshotState;
  theme: GerritDiffTheme;
  tabSize: number;
  onPathChange(path: string): void;
}) {
  const codeViewOptions = useMemo<CodeViewOptions<unknown>>(() => ({
    layout: { paddingTop: 0, gap: 0, paddingBottom: 0 },
    themeType: theme,
    theme: theme === "dark" ? "pierre-dark" : "pierre-light",
    overflow: "scroll",
    stickyHeaders: true,
    enableLineSelection: false,
    unsafeCSS: `:host { --diffs-tab-size: ${tabSize}; }`,
  }), [tabSize, theme]);
  const items = useMemo<CodeViewItem<unknown>[]>(() => state.status === "ready" ? [{
    id: `${label}:${path}`,
    type: "file",
    file: { name: path, contents: state.content, cacheKey: `${revisionLabel}:${path}` },
  }] : [], [label, path, revisionLabel, state]);

  return (
    <section className="moved-code-pane">
      <header>
        <span>{label}</span>
        <strong>{revisionLabel}</strong>
        <select aria-label={`${label} file`} value={path} onChange={(event) => onPathChange(event.target.value)}>
          {options.map((option) => <option key={option.path} value={option.path}>{option.path}</option>)}
        </select>
      </header>
      {state.status === "loading" && <div className="moved-code-state"><LoaderCircle className="spinner" size={17} /><span>Loading {path}…</span></div>}
      {state.status === "error" && <div className="moved-code-state is-error"><FileText size={17} /><span>{state.message}</span></div>}
      {state.status === "ready" && (
        <CodeView<unknown>
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
  onClose,
}: {
  sourceUrl: string;
  oldFiles: FileSnapshotOption[];
  newFiles: FileSnapshotOption[];
  baseLabel: string;
  targetLabel: string;
  theme: GerritDiffTheme;
  tabSize: number;
  onClose(): void;
}) {
  const [oldPath, setOldPath] = useState(() => preferredPath(oldFiles));
  const [newPath, setNewPath] = useState(() => preferredPath(newFiles));
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
        <button type="button" onClick={onClose}><X size={13} /> Close</button>
      </div>
      <div className="moved-code-grid">
        <SnapshotPane label="Before" revisionLabel={baseLabel} options={oldFiles} path={oldPath} state={oldState} theme={theme} tabSize={tabSize} onPathChange={setOldPath} />
        <span className="moved-code-direction" aria-hidden="true"><ArrowRight size={14} /></span>
        <SnapshotPane label="After" revisionLabel={targetLabel} options={newFiles} path={newPath} state={newState} theme={theme} tabSize={tabSize} onPathChange={setNewPath} />
      </div>
    </div>
  );
}
