import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/index.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "test", "fixtures", "shop");

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  try {
    const code = await main(argv);
    return { code, out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe("cli", () => {
  it("parses flags in both --flag value and --flag=value forms", () => {
    const a = parseArgs(["pack", "q", "dir", "--budget=500", "-f", "a.ts", "--focus", "b.ts", "--format", "xml", "-n"]);
    expect(a).toMatchObject({ command: "pack", positional: ["q", "dir"], budget: 500, focus: ["a.ts", "b.ts"], format: "xml", lineNumbers: true });
  });

  it("packs context to stdout and a summary to stderr", async () => {
    const r = await run(["pack", "how are items added to the cart", fixture, "-b", "1500"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^# Context for: how are items added to the cart/);
    expect(r.out).toContain("## src/lib/cart.ts");
    expect(r.err).toMatch(/Packed \d+ of 8 files/);
  });

  it("search explains each result", async () => {
    const r = await run(["search", "login", fixture, "--limit", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1\. .*\n\s+matches login/);
  });

  it("accepts a focus file relative to the current folder or the project", async () => {
    const r = await run(["pack", "why is the total wrong", fixture, "-f", "src/lib/cart.ts", "--format", "json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).files[0].path).toBe("src/lib/cart.ts");
    const bad = await run(["pack", "x", fixture, "-f", "nope.ts"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not a file in the index");
  });

  it("saves an index and can search it later without the source folder", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "idx.json");
    expect((await run(["index", fixture, "-o", out])).code).toBe(0);
    const r = await run(["search", "cart", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("src/lib/cart.ts");
  });

  it("runs a benchmark", async () => {
    const bench = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "b.json");
    fs.writeFileSync(bench, JSON.stringify({ name: "shop", cases: [{ q: "add to cart", relevant: ["src/lib/cart.ts"] }] }));
    const r = await run(["eval", bench, fixture, "-b", "2000"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/contextcode\s+100%/);
  });

  it("exits 2 with a clear message on bad input", async () => {
    expect((await run(["pack"])).err).toContain("needs a question");
    expect((await run(["pack", "q", "/definitely/not/here"])).code).toBe(2);
    expect((await run(["pack", "q", "--budget", "-5"])).err).toContain("needs a value");
    expect((await run(["frobnicate"])).err).toContain('Unknown command "frobnicate"');
  });
});
