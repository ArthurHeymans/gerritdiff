import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Load the real TSX components in Node; replace only browser/router boundaries.
const root = new URL("../../", import.meta.url);
const modules = {
  "next/navigation": `
    export const useRouter = () => globalThis.testNavigation.router;
    export const usePathname = () => globalThis.testNavigation.pathname;
    export const useSearchParams = () => globalThis.testNavigation.params;
  `,
  "@/lib/theme": `export const useGerritDiffTheme = () => 'light'; export const setGerritDiffTheme = () => {};`,
  "@/components/change-review": `
    import { createElement } from 'react';
    export const ChangeReview = ({data}) => createElement('div', {'data-revision': data.revisionNumber});
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in modules) return { url: `mock:${specifier}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: new URL(specifier.slice(2) + (specifier.includes("components/") ? ".tsx" : ".ts"), root).href, shortCircuit: true };
    // Next's CJS subpath exports omit extensions.
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    return nextResolve(specifier, context.parentURL?.startsWith("mock:") ? { ...context, parentURL: root.href } : context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("mock:")) return { format: "module", source: modules[url.slice(5)], shortCircuit: true };
    if (/\.tsx?$/.test(url) && url.startsWith(root.href)) {
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        fileName: fileURLToPath(url),
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
