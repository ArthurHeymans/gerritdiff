import type { CodeViewOptions } from "@pierre/diffs";
import type { GerritDiffTheme } from "@/lib/theme";

export const WHITESPACE_MARKER_CSS = `
  :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="space"] { color: transparent; background-image: radial-gradient(circle, color-mix(in srgb, var(--diffs-fg) 42%, transparent) 1px, transparent 1.2px); background-position: .5ch center; background-repeat: repeat-x; background-size: 1ch 100%; }
  :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="tab"] { position: relative; color: transparent; }
  :is(:host([data-show-whitespace]), [data-show-whitespace]) [data-whitespace-marker="tab"]::before { content: "→"; position: absolute; inset-inline-start: 0; color: color-mix(in srgb, var(--diffs-fg) 48%, transparent); pointer-events: none; }
`;

export function createCodeViewDiffOptions<T>({
  theme,
  diffStyle,
  tabSize,
  unsafeCSS = "",
}: {
  theme: GerritDiffTheme;
  diffStyle: "split" | "unified";
  tabSize: number;
  unsafeCSS?: string;
}): CodeViewOptions<T> {
  return {
    themeType: theme,
    theme: theme === "dark" ? "pierre-dark" : "pierre-light",
    diffStyle,
    diffIndicators: "bars",
    overflow: "scroll",
    lineDiffType: "word-alt",
    hunkSeparators: "line-info-basic",
    unsafeCSS: `:host { --diffs-tab-size: ${tabSize}; } ${WHITESPACE_MARKER_CSS} ${unsafeCSS}`,
  };
}

export function textPosition(line: HTMLElement, character: number) {
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

export function textMatchRanges(line: HTMLElement, query: string) {
  const normalizedText = (line.textContent ?? "").toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const ranges: Range[] = [];
  let index = normalizedText.indexOf(normalizedQuery);
  while (index >= 0) {
    const start = textPosition(line, index);
    const end = textPosition(line, index + query.length);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
    index = normalizedText.indexOf(normalizedQuery, index + Math.max(query.length, 1));
  }
  return ranges;
}

export function updateWhitespaceMarkers(root: HTMLElement | ShadowRoot, visible: boolean) {
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
      const fragment = document.createDocumentFragment();
      for (const part of textNode.data.split(/( +|\t)/)) {
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
