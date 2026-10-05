import type { FileContents, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { GerritComment } from "./types.ts";

export type GerritTextRange = { start_line: number; start_character: number; end_line: number; end_character: number };
export type LocalReviewComment = { key: string; path: string; message: string; range: SelectedLineRange; textRange?: GerritTextRange; gerritLine?: number; gerritRange?: GerritTextRange; parent?: number; inReplyTo?: string; unresolved?: boolean };
export type GerritCommentInput = {
  // Omitted for /PATCHSET_LEVEL comments; Gerrit defaults to REVISION.
  side?: "PARENT" | "REVISION";
  parent?: number;
  line?: number;
  range?: GerritTextRange;
  in_reply_to?: string;
  message: string;
  unresolved?: boolean;
};

/** Parent coordinates cannot be used on a different patchset's left-hand side. */
export function commentIsOnDisplayedSide(comment: GerritComment, baseRevisionNumber?: number) {
  return comment.side !== "PARENT" || (baseRevisionNumber === undefined && comment.path !== "/COMMIT_MSG");
}

export function wholeLineRange(range: SelectedLineRange, file: FileDiffMetadata | FileContents | undefined): GerritTextRange | undefined {
  if (!file || range.start <= 0 || range.end <= 0) return undefined;
  const side = range.endSide ?? range.side ?? "additions";
  if (range.side && range.side !== side) return undefined;
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  let lineText: string | undefined;
  if ("contents" in file) {
    lineText = file.contents.split("\n")[endLine - 1];
  } else {
    const lines = side === "deletions" ? file.deletionLines : file.additionLines;
    if (!file.isPartial) lineText = lines[endLine - 1];
    else {
      const hunk = file.hunks.find((candidate) => {
        const start = side === "deletions" ? candidate.deletionStart : candidate.additionStart;
        const count = side === "deletions" ? candidate.deletionCount : candidate.additionCount;
        return endLine >= start && endLine < start + count;
      });
      if (hunk) {
        const start = side === "deletions" ? hunk.deletionStart : hunk.additionStart;
        const index = side === "deletions" ? hunk.deletionLineIndex : hunk.additionLineIndex;
        lineText = lines[index + endLine - start];
      }
    }
  }
  if (lineText === undefined) return undefined;
  return {
    start_line: startLine,
    start_character: 0,
    end_line: endLine,
    // Diff arrays retain line endings; Gerrit character offsets exclude them.
    end_character: lineText.replace(/\r?\n$/, "").replace(/\r$/, "").length,
  };
}

export function commentInput(comment: LocalReviewComment, file: FileDiffMetadata | undefined, lineOffset: number): GerritCommentInput {
  const side = comment.range.endSide ?? comment.range.side ?? "additions";
  // Gerrit rejects patchset-level comments carrying side, line or range.
  if (comment.path === "/PATCHSET_LEVEL") {
    const input: GerritCommentInput = { message: comment.message };
    if (comment.inReplyTo) input.in_reply_to = comment.inReplyTo;
    if (comment.unresolved !== undefined) input.unresolved = comment.unresolved;
    return input;
  }
  const offset = comment.path === "/COMMIT_MSG" ? lineOffset : 0;
  const input: GerritCommentInput = { side: side === "deletions" ? "PARENT" : "REVISION", message: comment.message };
  if (comment.parent !== undefined) input.parent = comment.parent;
  if (comment.inReplyTo) input.in_reply_to = comment.inReplyTo;
  if (comment.unresolved !== undefined) input.unresolved = comment.unresolved;
  // Replies retain exact server coordinates, including hidden /COMMIT_MSG headers.
  if (comment.gerritRange) {
    input.range = { ...comment.gerritRange };
    return input;
  }
  if (comment.gerritLine !== undefined) {
    input.line = comment.gerritLine;
    return input;
  }
  if (comment.textRange) {
    input.range = { ...comment.textRange, start_line: comment.textRange.start_line + offset, end_line: comment.textRange.end_line + offset };
    return input;
  }
  if (comment.range.start === comment.range.end) {
    if (comment.range.end > 0) input.line = comment.range.end + offset;
    return input;
  }
  const range = wholeLineRange(comment.range, file);
  if (!range) throw new Error("Comment range content is unavailable. Load the full file before commenting.");
  input.range = { ...range, start_line: range.start_line + offset, end_line: range.end_line + offset };
  return input;
}
