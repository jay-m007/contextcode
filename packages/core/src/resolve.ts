import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

/** Imports of these file types are assets handled by the bundler, not code modules. */
const ASSET_EXTENSIONS = new Set([
  ".css", ".scss", ".sass", ".less", ".styl",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".webm", ".mp3", ".wav",
  ".json", ".md", ".mdx", ".txt", ".html", ".glsl", ".graphql", ".gql", ".yaml", ".yml",
]);

const BUILTINS = new Set(builtinModules);

export type Resolution =
  | { type: "internal"; file: string } // absolute path of a file inside the project
  | { type: "external"; name: string } // npm package or Node built-in
  | { type: "asset" }
  | { type: "unresolved" };

export interface Resolver {
  resolve(specifier: string, fromFile: string): Resolution;
  /** Path of the tsconfig/jsconfig used for aliases, relative to root, or null. */
  configFile: string | null;
}

/**
 * Builds a resolver that turns an import specifier ("@/lib/db", "../utils",
 * "react") into either a concrete project file or an external package name.
 *
 * Rather than re-implementing Node/bundler resolution rules (extensions, index
 * files, package.json "exports", tsconfig "paths" and "baseUrl"...), we delegate
 * to TypeScript's own module resolver, which is what editors and Next.js's type
 * checker use. We just feed it the project's tsconfig.json or jsconfig.json.
 */
export function createResolver(root: string): Resolver {
  const { options, configFile } = loadCompilerOptions(root);
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const aliasMatchers = buildAliasMatchers(options.paths);

  const resolve = (specifier: string, fromFile: string): Resolution => {
    const bare = specifier.split("?")[0]; // strip loader queries like "./icon.svg?url"

    if (ASSET_EXTENSIONS.has(path.extname(bare).toLowerCase())) return { type: "asset" };

    if (bare.startsWith("node:")) return { type: "external", name: bare };

    // Project files win over Node built-in names: with "baseUrl", a local folder
    // called util/ or events/ is imported as "util/format", and must stay internal.
    const result = ts.resolveModuleName(bare, fromFile, options, ts.sys, cache).resolvedModule;
    const resolved = result ? path.resolve(result.resolvedFileName) : null;
    const inNodeModules = !!result && (result.isExternalLibraryImport || resolved!.includes(`${path.sep}node_modules${path.sep}`));

    if (resolved && !inNodeModules) return { type: "internal", file: resolved };

    const first = bare.split("/")[0];
    if (BUILTINS.has(bare) || BUILTINS.has(first)) return { type: "external", name: `node:${first}` };

    if (inNodeModules) return { type: "external", name: packageName(bare) };

    // Not resolvable. A relative path or a configured alias that fails to
    // resolve is a real problem (typo, deleted file); a bare name is just a
    // package that isn't installed, which we still record as external.
    const isRelative = bare.startsWith(".") || bare.startsWith("/");
    const isAlias = aliasMatchers.some((re) => re.test(bare));
    // "components/Buton" with baseUrl: the folder exists locally, so it's a typo, not a package.
    const isBaseUrlPath = !!options.baseUrl && fs.existsSync(path.join(options.baseUrl, first));
    if (isRelative || isAlias || isBaseUrlPath) return { type: "unresolved" };
    return { type: "external", name: packageName(bare) };
  };

  return { resolve, configFile: configFile ? toPosix(path.relative(root, configFile)) : null };
}

function loadCompilerOptions(root: string): { options: ts.CompilerOptions; configFile: string | null } {
  const candidates = ["tsconfig.json", "jsconfig.json"].map((f) => path.join(root, f));
  const configFile = candidates.find((f) => fs.existsSync(f)) ?? null;

  let options: ts.CompilerOptions = {};
  if (configFile) {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (!read.error) {
      // parseJsonConfigFileContent follows "extends" chains and normalises paths.
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile), undefined, configFile);
      options = parsed.options;
    }
  }

  return {
    configFile,
    options: {
      ...options,
      // Override settings so resolution behaves like a modern bundler (Next.js,
      // Vite, webpack): extensionless relative imports, JS files, index files.
      allowJs: true,
      checkJs: false,
      resolveJsonModule: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
  };
}

/** Turns tsconfig "paths" keys like "@/*" into regexes so we can recognise alias imports. */
function buildAliasMatchers(paths: ts.MapLike<string[]> | undefined): RegExp[] {
  if (!paths) return [];
  return Object.keys(paths).map((key) => {
    const escaped = key.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", ".*");
    return new RegExp(`^${escaped}$`);
  });
}

/** "@scope/pkg/sub/path" -> "@scope/pkg", "lodash/fp" -> "lodash". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
