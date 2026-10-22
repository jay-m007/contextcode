/**
 * Packing: fitting the best files into a token budget.
 *
 * Each ranked file can be included at one of three levels of detail:
 *
 *   full     the whole file
 *   focused  the declarations that match the question in full, every other
 *            declaration as a one-line signature, and the imports
 *   outline  only the signatures: names, parameters and return types
 *
 * Files are taken in ranked order and each gets the richest level that fits.
 * No single file may take more than a share of the budget, so one huge file
 * can't crowd out everything else. Leftover budget then upgrades earlier files
 * to a richer level.
 *
 * Runs in Node and in the browser.
 */
import { rankSymbols, queryTerms, search, symbolId, type Prepared, type SearchOptions } from "./search.js";
import { estimateTokens, languageOf } from "./text.js";
import type { CodeSymbol, IndexedFile, Pack, PackedFile, Ranked, Tier } from "./types.js";

export interface PackOptions extends SearchOptions {
  /** Token budget for the whole output (default 8000). */
  budget?: number;
  /** Largest share of the budget one file may use (default 0.4). */
  maxFileShare?: number;
  /** Ignore files scoring below this fraction of the best file (default 0.08). */
  minRelativeScore?: number;
  /** How many matching declarations to show in full in a focused file (default 3). */
  focusedSymbols?: number;
  /** "breadth" (default): a focused view of many files first, then upgrade. "depth": the richest view of each file in turn. */
  strategy?: "breadth" | "depth";
  /** Manual choices from the user: a fixed detail level for a file, or "off" to leave it out. */
  overrides?: Record<string, Tier | "off">;
  /** Prefix each line with its line number (default false). */
  lineNumbers?: boolean;
}

export type Format = "markdown" | "xml" | "json";

const ORDER: Tier[] = ["full", "focused", "outline"];
/** A matching declaration longer than this is cut in a focused view. */
const MAX_BODY_LINES = 80;
/** Files with more declarations than this get a lean outline: one line per exported declaration. */
const LEAN_OUTLINE = 15;

/** Ranks the files for `query` and packs the best of them into the budget. */
export function pack(p: Prepared, query: string, options: PackOptions = {}): Pack {
  const ranked = search(p, query, { ...options, limit: options.limit ?? 80 });
  return packRanked(p, query, ranked, options);
}

/** Packs an already-ranked (and possibly hand-edited) list of files. Used by the web UI. */
export function packRanked(p: Prepared, query: string, ranked: Ranked[], options: PackOptions = {}): Pack {
  const budget = options.budget ?? 8000;
  const cap = Math.floor(budget * (options.maxFileShare ?? 0.4));
  const top = ranked[0]?.score ?? 0;
  const overrides = options.overrides ?? {};
  // A file the user pinned is included even if it didn't match the question.
  const listed = new Set(ranked.map((r) => r.path));
  const pinned: Ranked[] = Object.entries(overrides)
    .filter(([path, t]) => t !== "off" && !listed.has(path) && p.byPath.has(path))
    .map(([path]) => ({ path, score: 0, lexical: 0, graph: 0, reasons: [{ kind: "focus", detail: "added by you" }], matchedSymbols: [] }));
  const candidates = [...ranked, ...pinned].filter(
    (r) => overrides[r.path] !== "off" && (overrides[r.path] || r.score >= top * (options.minRelativeScore ?? 0.08)),
  );
  const qTerms = queryTerms(query);

  // Every candidate's three renderings, with their costs.
  type Choice = { r: Ranked; file: IndexedFile; render: Record<Tier, string>; cost: Record<Tier, number>; tier: Tier | null };
  const choices: Choice[] = candidates.map((r) => {
    const file = p.files[p.byPath.get(r.path)!];
    const render = {
      full: renderFull(file, options),
      focused: renderFocused(file, focusSet(p, file, r, qTerms, options.focusedSymbols ?? 3), options),
      outline: renderOutline(file),
    };
    const cost = {
      full: wrapCost(file, render.full, r),
      focused: wrapCost(file, render.focused, r),
      outline: wrapCost(file, render.outline, r),
    };
    return { r, file, render, cost, tier: null };
  });

  const header = estimateTokens(`# Context for: ${query}\n\n`) + 40;
  let used = header;
  const fits = (c: Choice, t: Tier, limit: number) => c.cost[t] <= limit && used + c.cost[t] <= budget;

  const strategy = options.strategy ?? "breadth";

  // The user's fixed choices come first and always count, even past the budget
  // (the UI shows the overflow rather than silently dropping what they chose).
  for (const c of choices) {
    const forced = overrides[c.r.path];
    if (forced && forced !== "off") {
      c.tier = forced;
      used += c.cost[forced];
    }
  }
  const auto = choices.filter((c) => !c.tier);
  const SMALL = 500; // files this small are cheaper to send whole than to summarise

  if (strategy === "depth") {
    // Richest level that fits, in ranked order.
    for (const c of auto) {
      const limit = c.r.reasons.some((x) => x.kind === "focus") ? Math.floor(budget * 0.6) : cap;
      for (const t of ORDER) {
        if (t === "focused" && c.render.focused === c.render.full) continue;
        if (t === "outline" && !c.render.outline.trim()) continue;
        if (fits(c, t, limit)) { c.tier = t; used += c.cost[t]; break; }
      }
    }
  } else {
    // Breadth first: every candidate, in ranked order, gets the cheapest useful
    // view (small files whole, others focused, outline as a fallback), so the
    // answer is still included when it's ranked 6th rather than 1st.
    for (const c of auto) {
      const limit = c.r.reasons.some((x) => x.kind === "focus") ? Math.floor(budget * 0.6) : cap;
      const order: Tier[] = c.cost.full <= SMALL || c.render.focused === c.render.full ? ["full", "outline"] : ["focused", "outline"];
      for (const t of order) {
        if (t === "outline" && !c.render.outline.trim()) continue;
        if (fits(c, t, limit)) { c.tier = t; used += c.cost[t]; break; }
      }
    }
  }

  // Then spend what's left upgrading files in ranked order (outline -> focused -> full).
  for (const c of auto) {
    if (!c.tier || c.tier === "full") continue;
    const limit = c.r.reasons.some((x) => x.kind === "focus") ? Math.floor(budget * 0.6) : cap;
    for (const t of ORDER.slice(0, ORDER.indexOf(c.tier))) {
      if (t === "focused" && c.render.focused === c.render.full) continue;
      const extra = c.cost[t] - c.cost[c.tier];
      if (c.cost[t] <= limit && extra > 0 && used + extra <= budget) {
        used += extra;
        c.tier = t;
        break;
      }
    }
  }

  const files: PackedFile[] = choices
    .filter((c) => c.tier)
    .map((c) => ({ path: c.r.path, tier: c.tier!, tokens: c.cost[c.tier!], score: c.r.score, reasons: c.r.reasons, content: c.render[c.tier!] }));
  return {
    query,
    budget,
    tokens: used,
    files,
    omitted: choices.filter((c) => !c.tier).map((c) => ({ path: c.r.path, score: c.r.score })),
  };
}

/** Which symbols a focused rendering shows in full. */
function focusSet(p: Prepared, file: IndexedFile, r: Ranked, qTerms: string[], k: number): Set<string> {
  const ids = r.matchedSymbols.length ? r.matchedSymbols : rankSymbols(p, file, qTerms).map(symbolId);
  return new Set(ids.slice(0, k));
}

const commentFor = (file: IndexedFile) => (file.kind === "doc" ? (s: string) => `<!-- ${s} -->` : (s: string) => `// ${s}`);

function numbered(lines: string[], from: number, on: boolean): string[] {
  if (!on) return lines;
  const width = String(from + lines.length).length;
  return lines.map((l, i) => `${String(from + i).padStart(width)}  ${l}`);
}

export function renderFull(file: IndexedFile, options: { lineNumbers?: boolean } = {}): string {
  return numbered(file.text.replace(/\n+$/, "").split("\n"), 1, !!options.lineNumbers).join("\n");
}

/**
 * The imports, then each top-level declaration: in full if it's in `show`,
 * otherwise as its signature. Gaps are marked with the line numbers left out,
 * so a reader (or a model) knows exactly what's missing and where.
 */
export function renderFocused(file: IndexedFile, show: Set<string>, options: { lineNumbers?: boolean } = {}): string {
  const lines = file.text.replace(/\n+$/, "").split("\n");
  const note = commentFor(file);
  const top = file.symbols.filter((s) => !s.parent);
  if (top.length === 0) {
    // No declarations to choose from (a script, or a doc with no headings): show the start.
    return lines.length <= 60 ? renderFull(file, options) : [...numbered(lines.slice(0, 60), 1, !!options.lineNumbers), note(`… lines 61–${lines.length} omitted`)].join("\n");
  }

  const out: string[] = [];
  let cursor = 1; // next line not yet accounted for
  const gap = (upTo: number) => {
    if (upTo <= cursor) return;
    out.push(note(upTo - 1 === cursor ? `… line ${cursor} omitted` : `… lines ${cursor}–${upTo - 1} omitted`));
  };
  const take = (from: number, to: number) => {
    gap(from);
    out.push(...numbered(lines.slice(from - 1, to), from, !!options.lineNumbers));
    cursor = Math.max(cursor, to + 1);
  };
  /** A matching declaration in full, unless it's very long: then its first MAX_BODY_LINES lines. */
  const takeCapped = (from: number, to: number) => {
    if (to - from + 1 <= MAX_BODY_LINES) return take(from, to);
    take(from, from + MAX_BODY_LINES - 1);
    out.push(note(`… lines ${from + MAX_BODY_LINES}–${to} omitted (long declaration)`));
    cursor = to + 1;
  };
  const signature = (s: CodeSymbol, indent = "") => {
    gap(s.startLine);
    const sig = s.signature.split("\n").map((l) => indent + l);
    const hasBody = s.endLine > s.startLine && file.kind !== "doc" && !isTypeLike(s);
    if (hasBody) sig[sig.length - 1] += s.kind === "variable" ? " …" : " { … }";
    out.push(...sig);
    cursor = s.endLine + 1; // the body is marked by "{ … }", not by an omitted-lines note
  };

  // Header: everything before the first declaration (imports, "use client"), up to 15 lines.
  const firstDecl = top[0].startLine;
  if (firstDecl > 1) take(1, Math.min(firstDecl - 1, 15));

  // In a big file, listing every other declaration costs more than it helps:
  // keep only exported ones, as one-line signatures.
  const lean = top.length > 12;

  for (const s of top) {
    if (s.startLine < cursor) continue; // nested in something already shown
    const methods = file.symbols.filter((m) => m.parent === s.name && s.kind === "class");
    const shownMethods = methods.filter((m) => show.has(symbolId(m)));
    if (show.has(symbolId(s)) || (file.kind === "doc" && show.has(s.name))) {
      takeCapped(s.startLine, s.endLine);
    } else if (shownMethods.length) {
      // The class header, its matching methods in full, the others as signatures, then the closing brace.
      signatureLine(s);
      for (const m of methods) {
        if (show.has(symbolId(m))) takeCapped(m.startLine, m.endLine);
        else signature(m, "  ");
      }
      if (s.endLine >= cursor) take(s.endLine, s.endLine);
    } else if (!lean || (s.exported && file.kind !== "doc")) {
      if (lean) {
        gap(s.startLine);
        const first = s.signature.split("\n")[0];
        out.push(first.length > 160 ? first.slice(0, 160) + " …" : first + (s.signature.includes("\n") || s.endLine > s.startLine ? " …" : ""));
        cursor = s.endLine + 1;
      } else {
        signature(s);
      }
    }
  }
  gap(lines.length + 1);
  return out.join("\n");

  function signatureLine(s: CodeSymbol) {
    gap(s.startLine);
    const sig = s.signature.split("\n");
    sig[sig.length - 1] += " {";
    out.push(...sig);
    cursor = s.startLine + sig.length;
  }
}

function isTypeLike(s: CodeSymbol): boolean {
  return s.kind === "interface" || s.kind === "type" || s.kind === "enum";
}

/** Only the declarations' signatures (Markdown: the headings). */
export function renderOutline(file: IndexedFile): string {
  if (file.kind === "doc") return file.symbols.map((s) => s.signature).join("\n");
  if (file.symbols.length > LEAN_OUTLINE) {
    const shown = file.symbols.filter((s) => s.exported && !s.parent);
    const lines = shown.map((s) => {
      const first = s.signature.split("\n")[0];
      const cut = first.length > 140 ? first.slice(0, 140) + " …" : first;
      return cut + (s.signature.includes("\n") || (s.endLine > s.startLine && !isTypeLike(s)) ? " …" : "");
    });
    const hidden = file.symbols.length - shown.length;
    if (hidden > 0) lines.push(`// + ${hidden} more declarations (not exported, or class members)`);
    return lines.join("\n");
  }
  const out: string[] = [];
  for (const s of file.symbols) {
    const indent = s.parent ? "  " : "";
    const sig = s.signature.split("\n");
    const body = s.endLine > s.startLine && !isTypeLike(s) && s.kind !== "variable" ? (s.kind === "class" ? " {" : " { … }") : "";
    out.push(...sig.slice(0, -1).map((l) => indent + l), indent + sig[sig.length - 1] + body);
    if (s.kind === "class") {
      const hasMethods = file.symbols.some((m) => m.parent === s.name);
      if (!hasMethods) out[out.length - 1] = out[out.length - 1].replace(/ \{$/, " { … }");
    }
    if (s.parent && s === lastMethodOf(file, s.parent)) out.push("}");
  }
  return out.join("\n");
}

function lastMethodOf(file: IndexedFile, cls: string): CodeSymbol | undefined {
  return file.symbols.filter((m) => m.parent === cls).pop();
}

/** The cost of a file in the final output: its content plus the heading and fences around it. */
function wrapCost(file: IndexedFile, content: string, r: Ranked): number {
  return estimateTokens(content) + estimateTokens(`## ${file.path} (focused) — ${explain(r.reasons)}\n\`\`\`${languageOf(file.path)}\n\n\`\`\`\n`) + 2;
}

/** One-line, human-readable reason for including a file. */
export function explain(reasons: Ranked["reasons"]): string {
  const parts: string[] = [];
  for (const r of reasons) {
    if (r.kind === "focus") parts.push("requested");
    if (r.kind === "match") parts.push(`matches ${r.detail}`);
    if (r.kind === "imported-by") parts.push(`used by ${r.detail}`);
    if (r.kind === "imports") parts.push(`uses ${r.detail}`);
  }
  return parts.join("; ") || "related";
}

/** Renders a pack as Markdown (readable by people and models), XML (the layout Anthropic recommends for long documents) or JSON. */
export function format(pk: Pack, fmt: Format = "markdown"): string {
  if (fmt === "json") return JSON.stringify(pk, null, 2);
  if (fmt === "xml") {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const docs = pk.files
      .map(
        (f, i) =>
          `<document index="${i + 1}">\n<source>${esc(f.path)}</source>\n<detail>${f.tier}</detail>\n<why>${esc(explain(f.reasons))}</why>\n<document_content>\n${esc(f.content)}\n</document_content>\n</document>`,
      )
      .join("\n");
    return `<context query="${esc(pk.query)}" files="${pk.files.length}" tokens="${pk.tokens}">\n<documents>\n${docs}\n</documents>\n</context>\n`;
  }
  const map = pk.files.map((f) => `- \`${f.path}\` (${f.tier}, ~${f.tokens} tokens): ${explain(f.reasons)}`).join("\n");
  const bodies = pk.files
    .map((f) => {
      const fence = f.content.includes("```") ? "````" : "```";
      return `## ${f.path} (${f.tier})\n${fence}${languageOf(f.path)}\n${f.content}\n${fence}`;
    })
    .join("\n\n");
  const legend =
    "Detail levels: full = whole file; focused = matching declarations in full, others as signatures; outline = signatures only. " +
    "Lines marked “omitted” exist in the file but were left out to save space.";
  return `# Context for: ${pk.query}\n\n${pk.files.length} files, ~${pk.tokens} tokens of a ${pk.budget}-token budget. ${legend}\n\n${map}\n\n${bodies}\n`;
}
