/**
 * Ranking: which files matter for a question?
 *
 * Two signals, each explainable:
 *
 *  1. Lexical (BM25). Classic search-engine scoring over each file's words,
 *     with extra weight for words in the file path and in declaration names,
 *     because "where is login handled?" is usually answered by a file called
 *     auth.ts or a function called login().
 *
 *  2. Structural (personalised PageRank). Starting from the best lexical hits,
 *     a random walk over the import graph spreads relevance to their
 *     neighbours: the types they use, the helpers they call, the page that
 *     calls them. That is how ContextCode finds files that never mention the
 *     query's words but are needed to understand the answer.
 *
 * Runs in Node and in the browser (no Node imports).
 */
import { splitIdentifier, stem, terms } from "./text.js";
import type { CodeSymbol, Index, IndexedFile, Ranked, Reason } from "./types.js";

// BM25 constants: k1 controls term-frequency saturation, b length normalisation.
const K1 = 1.2;
const B = 0.75;

const W_FILENAME = 4;
const W_DIR = 1.5;
const W_SYMBOL_EXPORTED = 3;
const W_SYMBOL = 2;
const W_DOC = 1.5;
const W_BODY = 1;
/** Prose documents use the same words as questions, so they'd outrank code without a discount. */
const DOC_FILE_FACTOR = 0.75;
/** Tests repeat the words of the code they test; the code itself is usually the better answer. */
const TEST_FILE_FACTOR = 0.6;
export const isTestFile = (p: string) => /(^|\/)(__tests__|tests?|__mocks__|e2e|spec)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(p);

export interface SearchOptions {
  /** Files the user is asking about directly; they rank first and seed the graph walk. */
  focus?: string[];
  /** Strength of the graph boost (default 0.3; 0 turns the graph off). */
  graphWeight?: number;
  /** Return at most this many results (default 50). */
  limit?: number;
}

export interface Prepared {
  index: Index;
  files: IndexedFile[];
  byPath: Map<string, number>;
  /** Weighted term frequencies from the path, declaration names and doc comments (not length-normalised). */
  tfStruct: Map<string, number>[];
  /** Term frequencies in the file body (length-normalised). */
  tfBody: Map<string, number>[];
  /** Body length (term count) per file, for BM25 length normalisation. */
  len: number[];
  avgLen: number;
  /** Document frequency: in how many files each term appears. */
  df: Map<string, number>;
}

/** Precomputes term statistics. Do this once per index; searches reuse it. */
export function prepare(index: Index): Prepared {
  const files = index.files;
  const tfStruct: Map<string, number>[] = [];
  const tfBody: Map<string, number>[] = [];
  const len: number[] = [];
  const df = new Map<string, number>();

  for (const f of files) {
    const st = new Map<string, number>();
    const add = (ts: string[], w: number) => {
      for (const t of ts) st.set(t, (st.get(t) ?? 0) + w);
    };
    const slash = f.path.lastIndexOf("/");
    const dir = f.path.slice(0, Math.max(slash, 0));
    let fileName = f.path.slice(slash + 1).replace(/\.[^.]+$/, "");
    // index.ts / page.tsx / route.ts are named by their folder.
    if (/^(index|page|route|layout|main|mod)$/.test(fileName)) fileName = dir.split("/").pop() ?? fileName;
    add(terms(fileName), W_FILENAME);
    add(terms(dir), W_DIR);
    for (const s of f.symbols) {
      add(terms(s.name), s.exported ? W_SYMBOL_EXPORTED : W_SYMBOL);
      if (s.doc) add(terms(s.doc), W_DOC);
    }
    const bodyTerms = terms(f.text);
    const body = new Map<string, number>();
    for (const t of bodyTerms) body.set(t, (body.get(t) ?? 0) + W_BODY);
    tfStruct.push(st);
    tfBody.push(body);
    len.push(Math.max(bodyTerms.length, 1));
    for (const t of new Set([...st.keys(), ...body.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const avgLen = len.reduce((a, b) => a + b, 0) / Math.max(len.length, 1);
  return { index, files, byPath: new Map(files.map((f, i) => [f.path, i])), tfStruct, tfBody, len, avgLen, df };
}

function idf(p: Prepared, term: string): number {
  const n = p.files.length;
  const d = p.df.get(term) ?? 0;
  return Math.log(1 + (n - d + 0.5) / (d + 0.5));
}

/** Query terms, deduplicated, keeping order. */
export function queryTerms(query: string): string[] {
  return [...new Set(terms(query))];
}

/** Ranks every file for a question. */
export function search(p: Prepared, query: string, options: SearchOptions = {}): Ranked[] {
  const qTerms = queryTerms(query);
  // Reasons show the user's own words ("score"), not the stems used for matching ("scor").
  const shown = new Map<string, string>();
  for (const w of query.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g) ?? []) for (const t of terms(w)) if (!shown.has(t)) shown.set(t, w.toLowerCase());
  const focus = (options.focus ?? []).filter((f) => p.byPath.has(f));
  const graphWeight = options.graphWeight ?? 0.3;
  const n = p.files.length;

  // 1. Lexical scores.
  const lexical = new Float64Array(n);
  const matched: string[][] = Array.from({ length: n }, () => []);
  const idfs = qTerms.map((t) => idf(p, t));
  for (let i = 0; i < n; i++) {
    // BM25F: only the body is normalised by length, so a long file whose
    // function is *named* after the query isn't penalised for being long.
    const norm = 1 - B + (B * p.len[i]) / p.avgLen;
    let s = 0;
    let hits = 0;
    for (let k = 0; k < qTerms.length; k++) {
      const f = (p.tfStruct[i].get(qTerms[k]) ?? 0) + (p.tfBody[i].get(qTerms[k]) ?? 0) / norm;
      if (!f) continue;
      hits++;
      matched[i].push(qTerms[k]);
      s += idfs[k] * ((f * (K1 + 1)) / (f + K1));
    }
    if (s > 0) {
      // Reward covering more of the question's words, not just repeating one.
      const coverage = hits / qTerms.length;
      s *= 0.5 + 0.5 * coverage;
      if (p.files[i].kind === "doc") s *= DOC_FILE_FACTOR;
      else if (isTestFile(p.files[i].path)) s *= TEST_FILE_FACTOR;
    }
    lexical[i] = s;
  }
  const maxLex = maxOf(lexical) || 1;

  // 2. Graph scores: personalised PageRank seeded by the best lexical hits and the focus files.
  const seeds = topIndices(lexical, 20).filter((i) => lexical[i] > 0);
  const restart = new Float64Array(n);
  for (const i of seeds) restart[i] = lexical[i] / maxLex;
  for (const f of focus) restart[p.byPath.get(f)!] = 2;
  const graph = personalisedPageRank(p, restart);
  const maxGraph = maxOf(graph) || 1;

  // 3. Combine and explain.
  const results: Ranked[] = [];
  const seedSet = new Set(seeds.slice(0, 5));
  for (let i = 0; i < n; i++) {
    const lex = lexical[i] / maxLex;
    const g = graph[i] / maxGraph;
    const isFocus = focus.includes(p.files[i].path);
    // Keywords decide; the graph boosts files near other good hits and lets in a
    // few files that never mention the words but sit next to the answer. An
    // additive mix scored worse on the benchmark (bench/), because hubs such as
    // a shared types.ts would jump above the actual answer.
    let score = lex > 0 ? lex * (1 + graphWeight * g) : GRAPH_ONLY * graphWeight * g;
    if (isFocus) score += 1;
    if (score < 0.01) continue;

    const reasons: Reason[] = [];
    if (isFocus) reasons.push({ kind: "focus", detail: "you asked about this file" });
    if (matched[i].length) reasons.push({ kind: "match", detail: [...new Set(matched[i].map((t) => shown.get(t) ?? t))].join(", ") });
    const f = p.files[i];
    const imported = f.imports.find((t) => seedSet.has(p.byPath.get(t)!) || focus.includes(t));
    const importer = f.importedBy.find((t) => seedSet.has(p.byPath.get(t)!) || focus.includes(t));
    if (importer) reasons.push({ kind: "imported-by", detail: importer });
    if (imported) reasons.push({ kind: "imports", detail: imported });

    results.push({ path: f.path, score, lexical: lex, graph: g, reasons, matchedSymbols: [] });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const limited = results.slice(0, options.limit ?? 50);

  // 4. Which declarations inside each file match best (used for "focused" packing).
  for (const r of limited) {
    r.matchedSymbols = rankSymbols(p, p.files[p.byPath.get(r.path)!], qTerms).map((s) => symbolId(s));
  }
  return limited;
}

/** "AuthService.login" for methods, "login" otherwise. */
export function symbolId(s: CodeSymbol): string {
  return s.parent ? `${s.parent}.${s.name}` : s.name;
}

/** Scores each declaration of a file against the query: name matches count most, then the doc comment, then the body. */
export function rankSymbols(p: Prepared, file: IndexedFile, qTerms: string[]): CodeSymbol[] {
  if (!qTerms.length || !file.symbols.length) return [];
  const lines = file.text.split("\n");
  const q = new Set(qTerms);
  const scored: { s: CodeSymbol; score: number }[] = [];
  for (const s of file.symbols) {
    let score = 0;
    for (const t of new Set(terms(s.name))) if (q.has(t)) score += 3 * idf(p, t);
    if (s.doc) for (const t of new Set(terms(s.doc))) if (q.has(t)) score += 1.5 * idf(p, t);
    const body = terms(lines.slice(s.startLine - 1, s.endLine).join("\n"));
    const counts = new Map<string, number>();
    for (const t of body) if (q.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) score += idf(p, t) * Math.log2(1 + c);
    if (score > 0) scored.push({ s, score });
  }
  // A class whose methods matched is represented by those methods, not by itself:
  // otherwise the class (whose body contains the methods) would always win, and a
  // focused view would show its first lines instead of the method that matters.
  const classesWithHits = new Set(scored.filter((x) => x.s.parent).map((x) => x.s.parent));
  return scored
    .filter((x) => !(x.s.kind === "class" && classesWithHits.has(x.s.name)))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/**
 * Personalised PageRank (random walk with restart).
 *
 * Imagine a reader who starts at one of the seed files, then repeatedly either
 * follows an import (in either direction) to a neighbouring file or, with
 * probability ALPHA, jumps back to a seed. The fraction of time they spend on
 * each file is its score. Files close to many seeds score high.
 *
 * Following an import forwards (to what a file uses) is weighted more than
 * backwards (to who uses it): to understand code you usually need its
 * dependencies more than its callers.
 */
const ALPHA = 0.3;
const FORWARD = 1;
const BACKWARD = 0.5;
const ITERATIONS = 40;
const HUB_DAMPING = 0.6;
/** A file with no keyword match scores at most this fraction of the graph weight. */
const GRAPH_ONLY = 0.67;

export function personalisedPageRank(p: Prepared, restart: Float64Array): Float64Array {
  const n = p.files.length;
  const total = restart.reduce((a, b) => a + b, 0);
  if (total === 0) return new Float64Array(n);
  const r = restart.map((x) => x / total);

  // Adjacency with weights, built once per call (cheap: O(E)).
  const nbrs: number[][] = Array.from({ length: n }, () => []);
  const wts: number[][] = Array.from({ length: n }, () => []);
  const outW = new Float64Array(n);
  p.files.forEach((f, i) => {
    for (const t of f.imports) {
      const j = p.byPath.get(t);
      if (j === undefined) continue;
      nbrs[i].push(j); wts[i].push(FORWARD); outW[i] += FORWARD;
      nbrs[j].push(i); wts[j].push(BACKWARD); outW[j] += BACKWARD;
    }
  });

  let rank = Float64Array.from(r);
  let lastBack = ALPHA;
  for (let it = 0; it < ITERATIONS; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (rank[i] === 0) continue;
      if (outW[i] === 0) { dangling += rank[i]; continue; }
      const share = ((1 - ALPHA) * rank[i]) / outW[i];
      const ns = nbrs[i], ws = wts[i];
      for (let k = 0; k < ns.length; k++) next[ns[k]] += share * ws[k];
    }
    const back = ALPHA + (1 - ALPHA) * dangling; // restarts plus walkers stuck on files with no imports
    for (let i = 0; i < n; i++) next[i] += back * r[i];
    lastBack = back;
    // Renormalise for files that had no neighbours (their (1-ALPHA) share went to `dangling` already).
    rank = next;
  }

  // Keep only what arrived by walking imports: the restart mass each seed gets
  // back by definition says nothing about its neighbourhood.
  // That includes walkers sent back from files with no imports, so subtract the
  // whole restart injected in the last step, not just ALPHA.
  for (let i = 0; i < n; i++) rank[i] = Math.max(0, rank[i] - lastBack * r[i]);

  // Shared hubs (a types.ts imported by everything) collect walkers from every
  // direction. They are useful context, but shouldn't outrank the actual answer,
  // so dampen by in-degree.
  for (let i = 0; i < n; i++) rank[i] /= 1 + HUB_DAMPING * Math.log1p(p.files[i].importedBy.length);
  return rank;
}

function maxOf(xs: Float64Array): number {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function topIndices(xs: Float64Array, k: number): number[] {
  return [...xs.keys()].sort((a, b) => xs[b] - xs[a]).slice(0, k);
}

export { splitIdentifier, stem };
