/**
 * Measuring retrieval quality.
 *
 * A benchmark is a list of questions about a real repository, each with the
 * files a developer would need to answer it. For each question we check
 * whether those files are ranked near the top, and whether they make it into
 * the packed context at a given budget.
 *
 * Three methods are compared:
 *   contextcode  BM25F keywords + import-graph walk (the default)
 *   keywords     BM25F keywords only (graph weight 0), to show what the graph adds
 *   grep         count the question's words in each file and paste whole files in
 *                that order until the budget runs out: what people do by hand
 */
import { pack, packRanked } from "./pack.js";
import { prepare, search, type Prepared } from "./search.js";
import { estimateTokens } from "./text.js";
import type { Index, Ranked } from "./types.js";

export interface BenchCase {
  q: string;
  relevant: string[];
}

export interface Bench {
  name: string;
  repo?: string;
  commit?: string;
  cases: BenchCase[];
}

export type Method = "contextcode" | "keywords" | "grep";
export const METHODS: Method[] = ["contextcode", "keywords", "grep"];

export interface CaseResult {
  q: string;
  method: Method;
  /** 1-based rank of each relevant file, or null if not ranked. */
  ranks: (number | null)[];
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  /** Fraction of relevant files present in the packed context at any detail level. */
  packRecall: number;
  /** Fraction present in full or focused form (with their code bodies, not just signatures). */
  packRecallDetailed: number;
  tokens: number;
}

export interface MethodSummary {
  method: Method;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  packRecall: number;
  packRecallDetailed: number;
  avgTokens: number;
}

export interface BenchResult {
  name: string;
  files: number;
  budget: number;
  cases: CaseResult[];
  summary: MethodSummary[];
  missing: string[];
}

export function evaluate(index: Index, bench: Bench, budget = 8000, methods: Method[] = METHODS): BenchResult {
  const p = prepare(index);
  const known = new Set(index.files.map((f) => f.path));
  const missing = [...new Set(bench.cases.flatMap((c) => c.relevant).filter((f) => !known.has(f)))];
  const cases: CaseResult[] = [];

  for (const c of bench.cases) {
    const relevant = c.relevant.filter((f) => known.has(f));
    if (!relevant.length) continue;
    for (const method of methods) {
      let ranked: string[];
      let packed: { path: string; detailed: boolean }[];
      let tokens: number;
      if (method === "grep") {
        ranked = grepRank(p, c.q);
        let used = 0;
        packed = [];
        for (const path of ranked) {
          const t = p.files[p.byPath.get(path)!].tokens + 20;
          if (used + t > budget) continue;
          used += t;
          packed.push({ path, detailed: true });
        }
        tokens = used;
      } else {
        const opts = { budget, graphWeight: method === "keywords" ? 0 : undefined, limit: 80 };
        const r: Ranked[] = search(p, c.q, opts);
        ranked = r.map((x) => x.path);
        const pk = method === "keywords" ? packRanked(p, c.q, r, opts) : pack(p, c.q, opts);
        packed = pk.files.map((f) => ({ path: f.path, detailed: f.tier !== "outline" }));
        tokens = pk.tokens;
      }
      const ranks = relevant.map((f) => {
        const i = ranked.indexOf(f);
        return i === -1 ? null : i + 1;
      });
      const within = (k: number) => ranks.filter((r) => r !== null && r <= k).length / relevant.length;
      const first = Math.min(...ranks.map((r) => r ?? Infinity));
      const inPack = new Map(packed.map((x) => [x.path, x.detailed]));
      cases.push({
        q: c.q,
        method,
        ranks,
        recallAt5: within(5),
        recallAt10: within(10),
        reciprocalRank: Number.isFinite(first) ? 1 / first : 0,
        packRecall: relevant.filter((f) => inPack.has(f)).length / relevant.length,
        packRecallDetailed: relevant.filter((f) => inPack.get(f)).length / relevant.length,
        tokens,
      });
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const summary = methods.map((method) => {
    const rs = cases.filter((c) => c.method === method);
    return {
      method,
      recallAt5: mean(rs.map((r) => r.recallAt5)),
      recallAt10: mean(rs.map((r) => r.recallAt10)),
      mrr: mean(rs.map((r) => r.reciprocalRank)),
      packRecall: mean(rs.map((r) => r.packRecall)),
      packRecallDetailed: mean(rs.map((r) => r.packRecallDetailed)),
      avgTokens: Math.round(mean(rs.map((r) => r.tokens))),
    };
  });
  return { name: bench.name, files: index.files.length, budget, cases, summary, missing };
}

/** The baseline: how often do the question's words (case-insensitive) appear in each file? */
export function grepRank(p: Prepared, query: string): string[] {
  const STOP = new Set("how does do is are the a an and or to of in on for with what where which when why does work works handled set up".split(" "));
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  const scored = p.files.map((f) => {
    const text = f.text.toLowerCase() + "\n" + f.path.toLowerCase();
    let n = 0;
    for (const w of words) {
      let i = text.indexOf(w);
      while (i !== -1) {
        n++;
        i = text.indexOf(w, i + w.length);
      }
    }
    return { path: f.path, n };
  });
  return scored.filter((s) => s.n > 0).sort((a, b) => b.n - a.n || a.path.localeCompare(b.path)).map((s) => s.path);
}

export { estimateTokens };
