import type { GerritCommentLink } from "@/lib/types";

export type LinkifiedPart = { text: string; href?: string };

export function gerritDiffHref(href: string, currentGerritOrigin: string, returnTo?: string) {
  try {
    const url = new URL(href);
    const pathAndHash = `${url.pathname}${url.hash}`;
    let sourceUrl: string | undefined;
    if (/\/\+\/\d+(?:\/\d+)?(?:\/|$)/.test(pathAndHash) || /\/(?:#\/)?c\/\d+(?:\/\d+)?(?:\/|$)/.test(pathAndHash)) {
      sourceUrl = url.toString();
    } else if (url.origin === currentGerritOrigin) {
      const bareChange = url.pathname.match(/^\/(\d+)(?:\/(\d+))?\/?$/);
      if (bareChange) sourceUrl = `${url.origin}/c/${bareChange[1]}${bareChange[2] ? `/${bareChange[2]}` : ""}`;
    }
    if (!sourceUrl) return undefined;
    const query = new URLSearchParams({ url: sourceUrl });
    if (returnTo) query.set("return", returnTo);
    return `/?${query}`;
  } catch {
    return undefined;
  }
}

type LinkCandidate = {
  start: number;
  end: number;
  href: string;
  prefix: string;
  text: string;
  suffix: string;
  priority: number;
};

function expandTemplate(template: string, match: RegExpExecArray) {
  return template.replace(/\$(\$|&|`|'|\d{1,2})/g, (_, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return match[0];
    if (token === "`") return match.input.slice(0, match.index);
    if (token === "'") return match.input.slice(match.index + match[0].length);
    return match[Number(token)] ?? "";
  });
}

function safeHref(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function commentLinkCandidates(text: string, origin: string, links: GerritCommentLink[]) {
  return links.flatMap((link, priority): LinkCandidate[] => {
    if (link.enabled === false || !link.match || !link.link) return [];
    try {
      const expression = new RegExp(link.match, "g");
      const candidates: LinkCandidate[] = [];
      let match: RegExpExecArray | null;
      while ((match = expression.exec(text))) {
        if (!match[0]) {
          expression.lastIndex += 1;
          continue;
        }
        const href = safeHref(expandTemplate(link.link, match), origin);
        if (!href) continue;
        candidates.push({
          start: match.index,
          end: match.index + match[0].length,
          href,
          prefix: expandTemplate(link.prefix ?? "", match),
          text: expandTemplate(link.text ?? "$&", match),
          suffix: expandTemplate(link.suffix ?? "", match),
          priority,
        });
      }
      return candidates;
    } catch {
      return [];
    }
  });
}

function urlCandidates(text: string) {
  const candidates: LinkCandidate[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    if (match.index === undefined) continue;
    const url = match[0].replace(/[.,;:!?]+$/, "").replace(/[)}\]]+$/, (ending) => {
      const opening = ending[0] === ")" ? "(" : ending[0] === "}" ? "{" : "[";
      const before = match[0].slice(0, -ending.length);
      const excess = ending.length - Math.max(0, [...before].filter((character) => character === opening).length - [...before].filter((character) => character === ending[0]).length);
      return ending.slice(0, Math.max(0, ending.length - excess));
    });
    if (!url) continue;
    candidates.push({ start: match.index, end: match.index + url.length, href: url, prefix: "", text: url, suffix: "", priority: Number.MAX_SAFE_INTEGER });
  }
  return candidates;
}

export function linkifyText(text: string, origin: string, links: GerritCommentLink[] = []): LinkifiedPart[] {
  const candidates = [...commentLinkCandidates(text, origin, links), ...urlCandidates(text)]
    .toSorted((left, right) => left.start - right.start || left.priority - right.priority || right.end - left.end);
  const parts: LinkifiedPart[] = [];
  let offset = 0;
  for (const candidate of candidates) {
    if (candidate.start < offset) continue;
    if (candidate.start > offset) parts.push({ text: text.slice(offset, candidate.start) });
    if (candidate.prefix) parts.push({ text: candidate.prefix });
    if (candidate.text) parts.push({ text: candidate.text, href: candidate.href });
    if (candidate.suffix) parts.push({ text: candidate.suffix });
    offset = candidate.end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts.length ? parts : [{ text }];
}
