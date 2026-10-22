import type { Index } from "@contextcode/core/engine";

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks a JSON value is a ContextCode index before the app trusts its shape. */
export function isIndex(x: unknown): x is Index {
  if (!isObj(x) || !isObj(x.meta) || x.meta.tool !== "contextcode" || typeof x.meta.root !== "string" || !Array.isArray(x.files)) return false;
  const isSymbol = (s: unknown) =>
    isObj(s) &&
    typeof s.name === "string" &&
    typeof s.kind === "string" &&
    typeof s.signature === "string" &&
    typeof s.startLine === "number" &&
    typeof s.endLine === "number" &&
    (s.doc === undefined || typeof s.doc === "string") &&
    (s.parent === undefined || typeof s.parent === "string");
  const strings = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string");
  return (x.files as unknown[]).every(
    (f) =>
      isObj(f) &&
      typeof f.path === "string" &&
      typeof f.text === "string" &&
      typeof f.tokens === "number" &&
      (f.kind === "code" || f.kind === "doc") &&
      Array.isArray(f.symbols) &&
      f.symbols.every(isSymbol) &&
      strings(f.imports) &&
      strings(f.importedBy),
  );
}

export function projectName(index: Index): string {
  const parts = index.meta.root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "project";
}
