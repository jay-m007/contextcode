/**
 * Shared types. Everything in an Index is plain JSON, so an index built by the
 * CLI can be saved to disk and searched later in the browser.
 */

export type ImportKind =
  | "static" //        import x from "./x"
  | "side-effect" //   import "./polyfill"
  | "re-export" //     export * from "./x"  /  export { a } from "./x"
  | "dynamic" //       await import("./x")
  | "require" //       const x = require("./x")
  | "import-equals" // import x = require("./x")
  | "import-type"; //  type T = import("./x").T

/** A raw import found in a file, before path resolution. */
export interface RawImport {
  specifier: string;
  kind: ImportKind;
  /** True when the import is erased at compile time (import type / export type). */
  typeOnly: boolean;
  /** 1-based line number where the import appears. */
  line: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "component" // a function or const whose name starts with a capital letter and returns JSX
  | "section"; //  a heading section of a Markdown document

/** One declaration (or Markdown section) inside a file. */
export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The declaration's head without its body, e.g. `export async function login(email: string): Promise<User>`. */
  signature: string;
  /** First sentence of the JSDoc comment, if any. */
  doc?: string;
  /** For methods: the class they belong to. */
  parent?: string;
}

export interface IndexedFile {
  /** POSIX path relative to the project root. */
  path: string;
  kind: "code" | "doc";
  text: string;
  lines: number;
  tokens: number;
  symbols: CodeSymbol[];
  /** Project files this file imports (resolved, deduplicated). */
  imports: string[];
  /** Project files that import this file. */
  importedBy: string[];
  /** External packages this file imports. */
  packages: string[];
}

export interface Index {
  meta: {
    tool: "contextcode";
    version: string;
    root: string;
    generatedAt: string;
    durationMs: number;
    aliases: string | null;
  };
  files: IndexedFile[];
}

/** Why a file was ranked where it was. Shown to the user so the choice is never a black box. */
export interface Reason {
  kind: "match" | "imports" | "imported-by" | "focus";
  /** For "match": the query terms found. For graph reasons: the related file. */
  detail: string;
}

export interface Ranked {
  path: string;
  score: number;
  /** Keyword (BM25) part of the score, normalised to 0..1. */
  lexical: number;
  /** Graph (personalised PageRank) part of the score, normalised to 0..1. */
  graph: number;
  reasons: Reason[];
  /** Symbols in this file that best match the query, best first. */
  matchedSymbols: string[];
}

/** How much of a file is included in the packed context. */
export type Tier = "full" | "focused" | "outline";

export interface PackedFile {
  path: string;
  tier: Tier;
  tokens: number;
  score: number;
  reasons: Reason[];
  content: string;
}

export interface Pack {
  query: string;
  budget: number;
  tokens: number;
  files: PackedFile[];
  /** Ranked files that did not fit. */
  omitted: { path: string; score: number }[];
}
