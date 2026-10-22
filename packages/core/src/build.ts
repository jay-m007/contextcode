import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { extractImports, parse } from "./extract.js";
import { createResolver, packageName, toPosix } from "./resolve.js";
import { extractSections, extractSymbols } from "./symbols.js";
import { estimateTokens } from "./text.js";
import type { Index, IndexedFile } from "./types.js";

export const VERSION = "0.1.0";

export const CODE_GLOBS = ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"];
export const DOC_GLOBS = ["**/*.{md,mdx}"];

/** Never source: dependency folders, build caches, generated and minified files. */
export const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.vercel/**",
  "**/.cache/**",
  "**/*.d.ts",
  "**/*.min.js",
  "**/*.map",
  "**/CHANGELOG.md",
  "**/package-lock.json",
];

/** Build-output folders, skipped only when they sit next to a package.json (so src/lib/build/ is kept). */
const OUTPUT_DIRS = ["dist", "build", "out", "coverage"];

/** Files bigger than this are almost always generated or vendored, and would swamp any context window. */
export const MAX_FILE_BYTES = 400_000;

export interface BuildOptions {
  /** Include Markdown documentation (default true). */
  docs?: boolean;
  /** Extra glob patterns to exclude. */
  exclude?: string[];
}

/**
 * Reads a project into an Index: every source file with its text, its
 * declarations (symbols), and the import graph between files.
 *
 * Import extraction and resolution are the same as in ArchGuard: the TypeScript
 * parser finds every import, and TypeScript's own module resolver turns
 * "@/lib/auth" into a real file using the project's tsconfig/jsconfig.
 */
export async function buildIndex(rootDir: string, options: BuildOptions = {}): Promise<Index> {
  const started = Date.now();
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

  const patterns = [...CODE_GLOBS, ...(options.docs === false ? [] : DOC_GLOBS)];
  const found = await fg(patterns, {
    cwd: root,
    ignore: [...ALWAYS_EXCLUDE, ...(options.exclude ?? [])],
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const isOutput = outputDirCheck(root);
  const paths = found.filter((f) => !isOutput(f)).sort();

  const resolver = createResolver(root);
  const idByReal = new Map<string, string>();
  for (const p of paths) idByReal.set(realpath(path.join(root, p)), p);

  const files: IndexedFile[] = [];
  for (const p of paths) {
    const abs = path.join(root, p);
    if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    if (text.includes("\u0000")) continue; // binary
    const isDoc = /\.mdx?$/i.test(p);

    const imports = new Set<string>();
    const packages = new Set<string>();
    const sf = isDoc ? undefined : parse(abs, text);
    if (sf) {
      for (const imp of extractImports(abs, text, sf)) {
        const res = resolver.resolve(imp.specifier, abs);
        if (res.type === "internal") {
          const target = idByReal.get(realpath(res.file));
          if (target && target !== p) imports.add(target);
        } else if (res.type === "external") {
          packages.add(res.name.startsWith("node:") ? res.name : packageName(res.name));
        }
      }
    }

    let symbols: IndexedFile["symbols"] = [];
    try {
      symbols = isDoc ? extractSections(text) : extractSymbols(abs, text, sf);
    } catch {
      symbols = []; // a file the parser can't handle is still searchable as text
    }

    files.push({
      path: p,
      kind: isDoc ? "doc" : "code",
      text,
      lines: text.split("\n").length,
      tokens: estimateTokens(text),
      symbols,
      imports: [...imports].sort(),
      importedBy: [],
      packages: [...packages].sort(),
    });
  }

  // Reverse edges.
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) {
    f.imports = f.imports.filter((t) => byPath.has(t));
    for (const t of f.imports) byPath.get(t)!.importedBy.push(f.path);
  }
  for (const f of files) f.importedBy.sort();

  return {
    meta: {
      tool: "contextcode",
      version: VERSION,
      root,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      aliases: resolver.configFile,
    },
    files,
  };
}

function outputDirCheck(root: string): (file: string) => boolean {
  const cache = new Map<string, boolean>();
  const hasPkg = (dir: string) => {
    if (!cache.has(dir)) cache.set(dir, fs.existsSync(path.join(root, dir, "package.json")));
    return cache.get(dir)!;
  };
  return (file) => {
    const parts = file.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (OUTPUT_DIRS.includes(parts[i]) && hasPkg(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export { toPosix };
