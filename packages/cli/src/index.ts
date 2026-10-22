#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, buildIndex, evaluate, explain, format, pack, prepare, search, VERSION, type Bench, type Format, type Index } from "@contextcode/core";

const HELP = `contextcode v${VERSION}: pick the right code context for an AI assistant

Usage
  contextcode pack   "<question>" [path] [options]   Print the packed context for a question
  contextcode search "<question>" [path] [options]   Show the ranked files and why
  contextcode index  [path] [-o file]                Save an index for the web UI
  contextcode ask    "<question>" [path] [options]   Answer the question with an AI model, using the packed context
  contextcode eval   <bench.json> [path] [-b n]      Measure retrieval quality on a benchmark

[path] is a project folder (default: current folder) or an index file made by "contextcode index".

Options
  -b, --budget <tokens>    Token budget for pack (default: 8000)
  -f, --focus <file>       A file you're asking about; ranks first. Repeatable
      --format <fmt>       markdown | xml | json (default: markdown)
  -o, --out <file>         Write to a file instead of stdout
  -n, --line-numbers       Prefix code lines with their line numbers
      --limit <n>          Results shown by search (default: 15)
      --no-docs            Skip Markdown files
      --no-graph           Rank by keywords only, without the import-graph boost
      --exclude <glob>     Skip matching files. Repeatable
      --model <name>       ask: model name (default: $OPENAI_MODEL or gpt-4o-mini)
      --base-url <url>     ask: any OpenAI-compatible API (default: $OPENAI_BASE_URL or OpenAI)
      --show-context       ask: also print the context that was sent
  -h, --help               Show this help
  -v, --version            Show the version

Examples
  contextcode pack "how does login work?" ./my-app -b 6000 > context.md
  contextcode search "where are payments handled" .
  contextcode pack "why does saving fail" -f src/lib/save.ts --format xml
  OPENAI_API_KEY=sk-... contextcode ask "where is the session cookie set?" .

ask reads the API key from $OPENAI_API_KEY. Only the packed context is sent, never the whole project.
`;

interface Args {
  command: string;
  positional: string[];
  budget: number;
  focus: string[];
  format: Format;
  out?: string;
  lineNumbers: boolean;
  limit: number;
  docs: boolean;
  exclude: string[];
  model?: string;
  baseUrl?: string;
  showContext: boolean;
  graph: boolean;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", positional: [], budget: 8000, focus: [], format: "markdown", lineNumbers: false, limit: 15, docs: true, exclude: [], showContext: false, graph: true };
  const expanded = argv.flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a]));
  const value = (i: number, flag: string) => {
    const v = expanded[i + 1];
    if (v === undefined || (v.startsWith("-") && v.length > 1)) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  const int = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive whole number (got "${v}")`);
    return n;
  };
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    switch (a) {
      case "-b": case "--budget": args.budget = int(value(i, a), a); i++; break;
      case "-f": case "--focus": args.focus.push(value(i, a)); i++; break;
      case "--format": {
        const f = value(i, a); i++;
        const map: Record<string, Format> = { markdown: "markdown", md: "markdown", xml: "xml", json: "json" };
        if (!map[f]) throw new UsageError(`--format must be markdown, xml or json (got "${f}")`);
        args.format = map[f];
        break;
      }
      case "-o": case "--out": args.out = value(i, a); i++; break;
      case "-n": case "--line-numbers": args.lineNumbers = true; break;
      case "--limit": args.limit = int(value(i, a), a); i++; break;
      case "--no-docs": args.docs = false; break;
      case "--exclude": args.exclude.push(value(i, a)); i++; break;
      case "--model": args.model = value(i, a); i++; break;
      case "--base-url": args.baseUrl = value(i, a); i++; break;
      case "--show-context": args.showContext = true; break;
      case "--no-graph": args.graph = false; break;
      case "-h": case "--help": args.command = "help"; break;
      case "-v": case "--version": args.command = "version"; break;
      default:
        if (a.startsWith("-") && a.length > 1) throw new UsageError(`Unknown option ${a}`);
        if (!args.command) args.command = a;
        else args.positional.push(a);
    }
  }
  return args;
}

async function loadIndex(target: string, args: Args): Promise<Index> {
  if (target.endsWith(".json") && fs.existsSync(target) && fs.statSync(target).isFile()) {
    const data = JSON.parse(fs.readFileSync(target, "utf8"));
    if (data?.meta?.tool !== "contextcode" || !Array.isArray(data.files)) throw new UsageError(`${target} isn't a ContextCode index`);
    return data as Index;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new UsageError(`Not a folder or index file: ${target}`);
  return buildIndex(target, { docs: args.docs, exclude: args.exclude });
}

/** Turns "--focus ./src/a.ts" or an absolute path into the index's relative POSIX form. */
function normaliseFocus(index: Index, focus: string[]): string[] {
  const known = new Set(index.files.map((f) => f.path));
  return focus.map((f) => {
    const abs = path.resolve(f);
    const rel = path.relative(index.meta.root, abs).split(path.sep).join("/");
    const candidate = known.has(rel) ? rel : f.replace(/^\.\//, "").split(path.sep).join("/");
    if (!known.has(candidate)) throw new UsageError(`--focus ${f}: not a file in the index`);
    return candidate;
  });
}

function write(text: string, out?: string) {
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

const info = (s: string) => process.stderr.write(`${s}\n`);

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    info(`Error: ${(err as Error).message}\n\nRun "contextcode --help" for usage.`);
    return 2;
  }
  try {
    switch (args.command) {
      case "":
      case "help":
        write(HELP);
        return 0;
      case "version":
        write(VERSION);
        return 0;
      case "index": {
        const target = path.resolve(args.positional[0] ?? ".");
        const index = await loadIndex(target, args);
        const out = args.out ?? "contextcode-index.json";
        fs.writeFileSync(out, JSON.stringify(index));
        info(`Indexed ${index.files.length} files in ${index.meta.durationMs} ms → ${out}`);
        return 0;
      }
      case "ask": {
        const [question, target = "."] = args.positional;
        if (!question) throw new UsageError('ask needs a question, e.g. contextcode ask "how does login work?"');
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new UsageError("ask needs an API key in OPENAI_API_KEY (any OpenAI-compatible provider works; set --base-url for others)");
        const index = await loadIndex(path.resolve(target), args);
        if (index.files.length === 0) throw new UsageError(`No JavaScript or TypeScript files found in ${index.meta.root}`);
        const pk = pack(prepare(index), question, { focus: normaliseFocus(index, args.focus), budget: args.budget, lineNumbers: true, graphWeight: args.graph ? undefined : 0 });
        if (pk.files.length === 0) throw new UsageError("Nothing in the project matches the question. Try other words or name a file with --focus.");
        if (args.showContext) write(format(pk, "markdown") + "\n---\n");
        info(`Sending ${pk.files.length} files (~${pk.tokens} tokens) to ${args.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini"}…\n`);
        const res = await ask(pk, {
          apiKey,
          model: args.model ?? process.env.OPENAI_MODEL,
          baseUrl: args.baseUrl ?? process.env.OPENAI_BASE_URL,
          onToken: (t) => process.stdout.write(t),
        });
        process.stdout.write("\n");
        info(`\nContext: ${pk.files.map((f) => `${f.path} (${f.tier})`).join(", ")}`);
        if (res.usage) info(`Tokens: ${res.usage.prompt} in, ${res.usage.completion} out (${res.model}).`);
        info("Answers are AI-generated from the context above; check the cited lines before relying on them.");
        return 0;
      }
      case "pack":
      case "search": {
        const [question, target = "."] = args.positional;
        if (!question) throw new UsageError(`${args.command} needs a question, e.g. contextcode ${args.command} "how does login work?"`);
        const index = await loadIndex(path.resolve(target), args);
        if (index.files.length === 0) throw new UsageError(`No JavaScript or TypeScript files found in ${index.meta.root}`);
        const focus = normaliseFocus(index, args.focus);
        const prepared = prepare(index);

        if (args.command === "search") {
          const ranked = search(prepared, question, { focus, limit: args.limit, graphWeight: args.graph ? undefined : 0 });
          if (args.format === "json") {
            write(JSON.stringify(ranked, null, 2), args.out);
          } else {
            const lines = ranked.map((r, i) => {
              const syms = r.matchedSymbols.slice(0, 3).join(", ");
              return `${String(i + 1).padStart(3)}. ${r.score.toFixed(2)}  ${r.path}\n       ${explain(r.reasons)}${syms ? `\n       best matches: ${syms}` : ""}`;
            });
            write(`Top ${ranked.length} of ${index.files.length} files for "${question}"\n\n${lines.join("\n")}`, args.out);
          }
          return 0;
        }

        const pk = pack(prepared, question, { focus, budget: args.budget, lineNumbers: args.lineNumbers, graphWeight: args.graph ? undefined : 0 });
        write(format(pk, args.format), args.out);
        const tiers = ["full", "focused", "outline"].map((t) => `${pk.files.filter((f) => f.tier === t).length} ${t}`).join(", ");
        info(`Packed ${pk.files.length} of ${index.files.length} files (${tiers}) into ~${pk.tokens}/${pk.budget} tokens${args.out ? ` → ${args.out}` : ""}.`);
        if (pk.files.length === 0) info("Nothing matched. Try different words, name a file with --focus, or raise --budget.");
        return 0;
      }
      case "eval": {
        const [benchFile, target = "."] = args.positional;
        if (!benchFile) throw new UsageError('eval needs a benchmark file, e.g. contextcode eval bench/commerce.json ../commerce');
        const bench = JSON.parse(fs.readFileSync(benchFile, "utf8")) as Bench;
        if (!Array.isArray(bench?.cases)) throw new UsageError(`${benchFile} has no "cases" array`);
        const index = await loadIndex(path.resolve(target), args);
        const res = evaluate(index, bench, args.budget);
        if (args.format === "json") {
          write(JSON.stringify(res, null, 2), args.out);
          return 0;
        }
        const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(6);
        const rows = res.summary.map(
          (s) => `${s.method.padEnd(12)}${pct(s.recallAt5)}${pct(s.recallAt10)}${s.mrr.toFixed(2).padStart(7)}${pct(s.packRecall)}${pct(s.packRecallDetailed)}${String(s.avgTokens).padStart(8)}`,
        );
        const lines = [
          `${bench.name}: ${bench.cases.length} questions, ${res.files} files, budget ${res.budget} tokens`,
          "",
          `${"method".padEnd(12)}${"R@5".padStart(6)}${"R@10".padStart(6)}${"MRR".padStart(7)}${"pack".padStart(6)}${"body".padStart(6)}${"tokens".padStart(8)}`,
          ...rows,
          "",
          "R@k: share of answer files ranked in the top k. MRR: 1 / rank of the first answer file.",
          "pack: share of answer files in the packed context. body: share included with their code (full or focused), not just signatures.",
        ];
        if (res.missing.length) lines.push("", `Warning: answer files not in the index: ${res.missing.join(", ")}`);
        write(lines.join("\n"), args.out);
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${args.command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      info(`Error: ${err.message}`);
      return 2;
    }
    info(`Error: ${(err as Error).stack ?? err}`);
    return 1;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
