"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, packRanked, prepare, queryTerms, search, type Format, type Index, type Tier } from "@contextcode/core/engine";
import { isIndex, projectName } from "@/lib/load";
import { BudgetMeter } from "./BudgetMeter";
import { EmptyState } from "./EmptyState";
import { FileList } from "./FileList";
import { Preview } from "./Preview";
import { ThemeToggle } from "./ThemeToggle";

export type Override = Tier | "off";

const DEMO_QUESTIONS = ["how are circular dependencies detected", "how does the github action comment on a pull request", "how is the health score calculated"];

export function App() {
  const [index, setIndex] = useState<Index | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [question, setQuestion] = useState("");
  const [query, setQuery] = useState(""); // debounced question
  const [budget, setBudget] = useState(8000);
  const [pinned, setPinned] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [fmt, setFmt] = useState<Format>("markdown");
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = useCallback((data: unknown, source: string, demo = false) => {
    if (!isIndex(data)) {
      setError(`${source} isn't a ContextCode index. Create one with: contextcode index ./your-project`);
      return;
    }
    setIndex(data);
    setIsDemo(demo);
    setPinned([]);
    setOverrides({});
    setError(null);
  }, []);

  // Start-up: ?index=url, or data/index.json when served next to the app, or ?demo.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const demo = params.has("demo");
    const url = demo ? "demo/index.json" : params.get("index") ?? "data/index.json";
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) accept(d, url, demo);
        if (demo) setQuestion(DEMO_QUESTIONS[0]);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [accept]);

  // Search as you type, but not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(question.trim()), 250);
    return () => clearTimeout(t);
  }, [question]);

  const prepared = useMemo(() => (index ? prepare(index) : null), [index]);
  const ranked = useMemo(
    () => (prepared && (query || pinned.length) ? search(prepared, query, { focus: pinned, limit: 60 }) : []),
    [prepared, query, pinned],
  );
  const pk = useMemo(
    () => (prepared ? packRanked(prepared, query, ranked, { budget, overrides }) : null),
    [prepared, query, ranked, budget, overrides],
  );
  const output = useMemo(() => (pk && pk.files.length ? format(pk, fmt) : ""), [pk, fmt]);
  const qTerms = useMemo(() => new Set(queryTerms(query)), [query]);

  const openFiles = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      accept(JSON.parse(await f.text()), f.name);
    } catch {
      setError(`${f.name} isn't valid JSON.`);
    }
  };

  const loadDemo = async () => {
    try {
      const d = await fetch("demo/index.json").then((r) => r.json());
      accept(d, "The demo index", true);
      setQuestion(DEMO_QUESTIONS[0]);
    } catch {
      setError("Couldn't load the demo. Open an index file instead.");
    }
  };

  const drop = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      openFiles(e.dataTransfer.files);
    },
  };

  const hiddenInput = (
    <input ref={fileInput} type="file" accept=".json,application/json" className="visually-hidden" onChange={(e) => openFiles(e.target.files).then(() => (e.target.value = ""))} />
  );

  if (loading) return <div className="shell shell--loading" aria-busy="true" />;

  if (!index || !prepared || !pk) {
    return (
      <div className={`shell${dragging ? " shell--drop" : ""}`} {...drop}>
        {hiddenInput}
        <EmptyState onOpen={() => fileInput.current?.click()} onDemo={loadDemo} error={error} />
      </div>
    );
  }

  const setOverride = (path: string, o: Override | null) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (o === null) delete next[path];
      else next[path] = o;
      return next;
    });

  return (
    <div className={`shell${dragging ? " shell--drop" : ""}`} {...drop}>
      {hiddenInput}
      <header className="topbar">
        <div className="brand">
          <Mark />
          <span>ContextCode</span>
        </div>
        <span className="topbar__project">
          <span className="mono">{projectName(index)}</span>
          <span className="muted">
            {index.files.length} files{isDemo ? ", demo" : ""}
          </span>
        </span>
        <div className="topbar__actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Open index
          </button>
          <ThemeToggle />
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          {error}
          <button className="btn btn--ghost" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="left" aria-label="Question and files">
          <div className="ask">
            <label htmlFor="question" className="ask__label">
              What do you want to ask the AI about this code?
            </label>
            <textarea
              id="question"
              className="ask__input"
              rows={3}
              placeholder="e.g. how does login work?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              spellCheck={false}
            />
            {!question && isDemo && (
              <div className="examples" aria-label="Example questions">
                {DEMO_QUESTIONS.map((q) => (
                  <button key={q} className="chip" onClick={() => setQuestion(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            <BudgetControl budget={budget} onChange={setBudget} />
          </div>

          <FileList
            index={index}
            ranked={ranked}
            pack={pk}
            query={query}
            pinned={pinned}
            overrides={overrides}
            onPin={(p) => setPinned((prev) => (prev.includes(p) ? prev : [...prev, p]))}
            onUnpin={(p) => setPinned((prev) => prev.filter((x) => x !== p))}
            onOverride={setOverride}
          />
        </section>

        <section className="right" aria-label="Packed context">
          <BudgetMeter pack={pk} />
          <Preview output={output} fmt={fmt} onFormat={setFmt} qTerms={qTerms} project={projectName(index)} hasQuery={!!query || pinned.length > 0} />
        </section>
      </main>
    </div>
  );
}

const PRESETS = [2000, 4000, 8000, 16000, 32000];

function BudgetControl({ budget, onChange }: { budget: number; onChange: (n: number) => void }) {
  return (
    <div className="budget">
      <div className="budget__head">
        <label htmlFor="budget">Token budget</label>
        <output htmlFor="budget" className="mono">
          {budget.toLocaleString()}
        </output>
      </div>
      <input id="budget" type="range" min={1000} max={32000} step={500} value={budget} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="budget__presets" role="group" aria-label="Budget presets">
        {PRESETS.map((p) => (
          <button key={p} className="preset" aria-pressed={budget === p} onClick={() => onChange(p)}>
            {p / 1000}k
          </button>
        ))}
      </div>
    </div>
  );
}

function Mark() {
  // Three lines of text, the middle one highlighted: the product in one glyph.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="2.6" rx="1.2" fill="currentColor" opacity="0.55" />
      <rect x="3" y="10.7" width="12" height="2.6" rx="1.2" fill="var(--hl)" />
      <rect x="3" y="16.4" width="15" height="2.6" rx="1.2" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
