import type { Index } from "@contextcode/core/engine";

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks a JSON value is a ContextCode index before the app trusts its shape. */
export function isIndex(x: unknown): x is Index {
  if (!isObj(x) || !isObj(x.meta) || x.meta.tool !== "contextcode" || !Array.isArray(x.files)) return false;
  return (x.files as unknown[]).every(
    (f) =>
      isObj(f) &&
      typeof f.path === "string" &&
      typeof f.text === "string" &&
      typeof f.tokens === "number" &&
      (f.kind === "code" || f.kind === "doc") &&
      Array.isArray(f.symbols) &&
      Array.isArray(f.imports) &&
      Array.isArray(f.importedBy),
  );
}

export function projectName(index: Index): string {
  const parts = index.meta.root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "project";
}
