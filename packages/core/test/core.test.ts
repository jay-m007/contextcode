import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/build.js";
import { evaluate, grepRank } from "../src/evaluate.js";
import { format, pack, renderFocused, renderOutline } from "../src/pack.js";
import { prepare, search } from "../src/search.js";
import { extractSections, extractSymbols } from "../src/symbols.js";
import { estimateTokens, splitIdentifier, stem, terms } from "../src/text.js";
import type { Index } from "../src/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "shop");
let index: Index;
beforeAll(async () => {
  index = await buildIndex(fixture);
});
const file = (p: string) => index.files.find((f) => f.path === p)!;

describe("text", () => {
  it("splits identifiers in every common style", () => {
    expect(splitIdentifier("getUserSession")).toEqual(["get", "user", "session"]);
    expect(splitIdentifier("get_user_session")).toEqual(["get", "user", "session"]);
    expect(splitIdentifier("HTMLParser")).toEqual(["html", "parser"]);
  });

  it("stems word forms onto one term", () => {
    for (const w of ["rotate", "rotated", "rotation", "rotating"]) expect(stem(w)).toBe("rotat");
    expect(stem("dragging")).toBe("drag");
    expect(stem("selection")).toBe(stem("selected"));
  });

  it("maps abbreviations and full words to the same term", () => {
    expect(terms("authentication")).toEqual(terms("auth"));
    expect(terms("database")).toEqual(terms("db"));
    expect(terms("the code of a function")).toEqual([]); // filler and keywords dropped
  });

  it("keeps compound identifiers whole as well as split", () => {
    expect(terms("useSession")).toContain("usesession");
    expect(terms("useSession")).toContain("session");
  });

  it("estimates tokens conservatively", () => {
    expect(estimateTokens("x".repeat(360))).toBe(100);
  });
});

describe("symbols", () => {
  it("finds functions, classes with methods, types and components with line ranges", () => {
    const syms = file("src/lib/auth.ts").symbols;
    const names = syms.map((s) => (s.parent ? `${s.parent}.${s.name}` : s.name));
    expect(names).toEqual(["login", "logout", "SessionStore", "SessionStore.save", "SessionStore.find"]);
    const login = syms[0];
    expect(login).toMatchObject({ kind: "function", exported: true, startLine: 4, endLine: 10, doc: "Checks the password and starts a session." });
    expect(login.signature).toBe("export async function login(email: string, password: string): Promise<Session>");
    expect(file("src/components/CartButton.tsx").symbols[0]).toMatchObject({ name: "CartButton", kind: "component" });
    expect(file("src/lib/types.ts").symbols.map((s) => s.kind)).toEqual(["interface", "type"]);
  });

  it("splits Markdown into sections and ignores # inside code fences", () => {
    const secs = extractSections(fs.readFileSync(path.join(fixture, "docs/setup.md"), "utf8"));
    expect(secs.map((s) => s.name)).toEqual(["Setup", "Authentication", "Deployment"]);
    expect(secs[1].endLine).toBe(secs[2].startLine - 1);
  });

  it("does not throw on syntax it cannot fully parse", () => {
    expect(() => extractSymbols("x.ts", "export function (")).not.toThrow();
  });
});

describe("index", () => {
  it("resolves aliased and relative imports into a two-way graph", () => {
    expect(file("src/components/LoginForm.tsx").imports).toEqual(["src/lib/auth.ts"]);
    expect(file("src/lib/auth.ts").imports).toEqual(["src/lib/db.ts", "src/lib/types.ts"]);
    expect(file("src/lib/auth.ts").importedBy).toEqual(["src/components/LoginForm.tsx"]);
    expect(index.meta.aliases).toBe("tsconfig.json");
  });

  it("skips node_modules, build output next to a package.json, and docs when asked", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
    const write = (p: string, t: string) => {
      fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
      fs.writeFileSync(path.join(tmp, p), t);
    };
    write("package.json", "{}");
    write("src/a.ts", "export const a = 1");
    write("src/build/b.ts", "export const b = 1"); // real source in a folder called build
    write("dist/a.js", "export const a = 1");
    write("node_modules/x/index.js", "export const x = 1");
    write("README.md", "# Hi");
    expect((await buildIndex(tmp)).files.map((f) => f.path)).toEqual(["README.md", "src/a.ts", "src/build/b.ts"]);
    expect((await buildIndex(tmp, { docs: false })).files.map((f) => f.path)).toEqual(["src/a.ts", "src/build/b.ts"]);
  });
});

describe("search", () => {
  it("ranks the file that implements the answer first and explains why", () => {
    const r = search(prepare(index), "how does login authentication work?");
    expect(r[0].path).toBe("src/lib/auth.ts");
    expect(r[0].reasons.find((x) => x.kind === "match")?.detail).toContain("login");
    expect(r[0].matchedSymbols[0]).toBe("login");
  });

  it("uses the import graph to bring in related files that never mention the words", () => {
    const r = search(prepare(index), "how does login work");
    const db = r.find((x) => x.path === "src/lib/db.ts");
    expect(db).toBeDefined();
    expect(db!.reasons.some((x) => x.kind === "imported-by")).toBe(true);
    // Turning the graph off removes it (it has no keyword match for "login").
    expect(search(prepare(index), "how does login work", { graphWeight: 0 }).some((x) => x.path === "src/lib/db.ts")).toBe(false);
  });

  it("puts focus files first even with no keyword match", () => {
    const r = search(prepare(index), "why is the total wrong", { focus: ["src/lib/cart.ts"] });
    expect(r[0].path).toBe("src/lib/cart.ts");
    expect(r[0].reasons[0].kind).toBe("focus");
  });

  it("returns nothing for words that appear nowhere", () => {
    expect(search(prepare(index), "kubernetes helm chart")).toEqual([]);
  });
});

describe("pack", () => {
  it("never exceeds the budget", () => {
    const p = prepare(index);
    for (const budget of [150, 300, 600, 2000]) {
      const pk = pack(p, "login session cart database", { budget });
      expect(pk.tokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(format(pk)) ).toBeLessThanOrEqual(budget * 1.05 + 60);
    }
  });

  it("uses full files when the budget allows and cheaper views when it doesn't", () => {
    const p = prepare(index);
    const big = pack(p, "how are the password credentials checked", { budget: 4000 });
    expect(big.files[0]).toMatchObject({ path: "src/lib/auth.ts", tier: "full" });
    const small = pack(p, "how are the password credentials checked", { budget: 200 });
    expect(small.files.length).toBeGreaterThan(0);
    expect(small.files.every((f) => f.tier !== "full" || f.tokens < 200)).toBe(true);
  });

  it("focused view shows matching declarations in full and the rest as signatures, marking gaps", () => {
    const out = renderFocused(file("src/lib/auth.ts"), new Set(["SessionStore.find"]));
    expect(out).toContain('import { connectDatabase } from "./db";');
    expect(out).toContain("export async function login(email: string, password: string): Promise<Session> { … }");
    expect(out).toContain("  find(id: string): Session | undefined {\n    return this.sessions.get(id);\n  }");
    expect(out).toContain("  save(session: Session) { … }");
    expect(out).not.toContain("throw new Error");
  });

  it("outline lists every signature without bodies", () => {
    const out = renderOutline(file("src/lib/cart.ts"));
    expect(out).toContain("export function addToCart(items: CartItem[], sku: string): CartItem[] { … }");
    expect(out).toContain("export interface CartItem {");
    expect(out).not.toContain("reduce");
  });

  it("formats as Markdown, escaped XML and JSON", () => {
    const pk = pack(prepare(index), "add to cart", { budget: 2000 });
    expect(format(pk)).toMatch(/^# Context for: add to cart/);
    const xml = format(pk, "xml");
    expect(xml).toContain("<source>src/lib/cart.ts</source>");
    expect(xml).toContain("&lt;button"); // JSX is escaped inside XML
    expect(JSON.parse(format(pk, "json")).files.length).toBe(pk.files.length);
  });
});

describe("evaluate", () => {
  it("scores ranking and packing against known answers, with a grep baseline", () => {
    const res = evaluate(index, { name: "fixture", cases: [{ q: "how is an item added to the cart", relevant: ["src/lib/cart.ts", "src/components/CartButton.tsx"] }] }, 2000);
    const cc = res.summary.find((s) => s.method === "contextcode")!;
    expect(cc.recallAt5).toBe(1);
    expect(cc.packRecall).toBe(1);
    expect(res.summary.map((s) => s.method)).toEqual(["contextcode", "keywords", "grep"]);
    expect(grepRank(prepare(index), "cart")[0]).toMatch(/cart/i);
  });

  it("reports answer files that aren't in the index", () => {
    const res = evaluate(index, { name: "x", cases: [{ q: "cart", relevant: ["nope.ts", "src/lib/cart.ts"] }] });
    expect(res.missing).toEqual(["nope.ts"]);
  });
});
