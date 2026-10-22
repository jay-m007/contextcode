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

describe("cli ask", () => {
  it("needs an API key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const r = await run(["ask", "how does login work", fixture]);
    if (saved) process.env.OPENAI_API_KEY = saved;
    expect(r.code).toBe(2);
    expect(r.err).toContain("OPENAI_API_KEY");
  });

  it("streams the answer and lists the context it used", async () => {
    process.env.OPENAI_API_KEY = "test";
    const body = 'data: {"choices":[{"delta":{"content":"See src/lib/auth.ts:7."}}]}\n\ndata: [DONE]\n\n';
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const r = await run(["ask", "how are passwords checked", fixture, "--base-url", "http://local/v1", "--model", "tiny"]);
    const url = fetchSpy.mock.calls[0]?.[0];
    fetchSpy.mockRestore();
    delete process.env.OPENAI_API_KEY;
    expect(r.code).toBe(0);
    expect(r.out).toContain("See src/lib/auth.ts:7.");
    expect(r.err).toMatch(/Context: .*src\/lib\/auth\.ts/);
    expect(url).toBe("http://local/v1/chat/completions");
  });
});

describe("cli output through a pipe", () => {
  it("arrives complete at a slow reader", async () => {
    // A smoke test in plain Node, so it runs the same on Windows. Note: on Linux, Node writes
    // to pipes synchronously, so this can't reproduce the old truncation there; the fix
    // (setting process.exitCode instead of calling process.exit) is what prevents it.
    const { spawn, spawnSync } = await import("node:child_process");
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
    const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const args = [cli, "pack", "how is the budget packed", path.join(repo, "packages"), "-b", "32000"];

    const expected = Buffer.byteLength(spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 24 }).stdout);
    expect(expected).toBeGreaterThan(70_000);

    // A slow reader: pause after every chunk, so the CLI's writes back up in the pipe.
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    let received = 0;
    child.stdout.on("data", (d: Buffer) => {
      received += d.length;
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 25);
    });
    await new Promise((r) => child.on("close", r));
    expect(received).toBe(expected);
  });
});
