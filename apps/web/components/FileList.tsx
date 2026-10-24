"use client";

import { useMemo, useState } from "react";
import { explain, type Index, type Pack, type Ranked, type Tier } from "@contextcode/core/engine";
import type { Override } from "./App";

const TIERS: { id: Override; label: string; title: string }[] = [
  { id: "full", label: "Full", title: "Include the whole file" },
  { id: "focused", label: "Focused", title: "Matching declarations in full, the rest as signatures" },
  { id: "outline", label: "Outline", title: "Signatures only" },
  { id: "off", label: "Off", title: "Leave this file out" },
];

/**
 * The ranked files, each with why it was chosen and a control to override the
 * detail level ContextCode picked. Files the user pins rank first.
 */
export function FileList(props: {
  index: Index;
  ranked: Ranked[];
  pack: Pack;
  query: string;
  pinned: string[];
  overrides: Record<string, Override>;
  onPin: (path: string) => void;
  onUnpin: (path: string) => void;
  onOverride: (path: string, o: Override | null) => void;
}) {
  const { ranked, pack, overrides } = props;
  const packed = useMemo(() => new Map(pack.files.map((f) => [f.path, f])), [pack]);
  const top = ranked[0]?.score || 1;
  // Pinned/overridden files that the search didn't return still need a row.
  const extra = Object.keys(overrides).filter((p) => !ranked.some((r) => r.path === p));

  return (
    <div className="files">
      <div className="files__head">
        <h2>Files</h2>
        <AddFile index={props.index} pinned={props.pinned} onPin={props.onPin} />
      </div>

      {props.pinned.length > 0 && (
        <ul className="pins" aria-label="Pinned files">
          {props.pinned.map((p) => (
            <li key={p} className="pin">
              <span className="mono">{p}</span>
              <button className="pin__x" onClick={() => props.onUnpin(p)} aria-label={`Unpin ${p}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {ranked.length === 0 && extra.length === 0 ? (
        <p className="files__empty">
          {props.query ? "No file matches those words. Try other words, or pin a file you know is relevant." : "Type a question to rank this project's files."}
        </p>
      ) : (
        <ol className="rows">
          {[...ranked, ...extra.map((path) => ({ path, score: 0, reasons: [], matchedSymbols: [] }) as unknown as Ranked)].map((r, i) => {
            const p = packed.get(r.path);
            const o = overrides[r.path];
            const auto = p?.tier ?? null;
            const state = o ?? auto; // nothing selected when the packer simply couldn't fit it
            const slash = r.path.lastIndexOf("/");
            return (
              <li key={r.path} className={`row${p ? "" : " row--out"}`}>
                <div className="row__main">
                  <span className="row__rank mono" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="row__text">
                    <div className="row__path mono" title={r.path}>
                      <span className="row__dir">{r.path.slice(0, slash + 1)}</span>
                      <span className="row__file">{r.path.slice(slash + 1)}</span>
                    </div>
                    <div className="row__why">{r.reasons.length ? explain(r.reasons) : "added by you"}</div>
                    {r.matchedSymbols.length > 0 && (
                      <div className="row__syms mono" aria-label="Best matching declarations">
                        {r.matchedSymbols.slice(0, 3).join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="row__side">
                    <span className="row__tokens mono">{p ? `${p.tokens.toLocaleString()} tok` : "—"}</span>
                    <span className="score" aria-label={`Relevance ${Math.round((r.score / top) * 100)}%`}>
                      <span style={{ width: `${Math.min(100, (r.score / top) * 100)}%` }} />
                    </span>
                  </div>
                </div>
                <div className="row__tiers" role="radiogroup" aria-label={`Detail level for ${r.path}`}>
                  <span className="row__tiers-label" aria-hidden="true">
                    Include
                  </span>
                  {TIERS.map((t) => (
                    <button
                      key={t.id}
                      role="radio"
                      aria-checked={state === t.id}
                      className={`tier${state === t.id ? " tier--on" : ""}${o === t.id ? " tier--manual" : ""}`}
                      title={t.title}
                      onClick={() => props.onOverride(r.path, o === t.id ? null : (t.id as Tier | "off"))}
                    >
                      {t.label}
                    </button>
                  ))}
                  {o ? (
                    <button className="tier tier--reset" onClick={() => props.onOverride(r.path, null)} title="Let ContextCode choose again">
                      Auto
                    </button>
                  ) : (
                    <span className="tier__auto">{auto ? "auto" : "didn't fit"}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** A small file finder: pin a file you know matters, even if the question doesn't mention it. */
function AddFile({ index, pinned, onPin }: { index: Index; pinned: string[]; onPin: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return index.files
      .filter((f) => f.path.toLowerCase().includes(s) && !pinned.includes(f.path))
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 8);
  }, [q, index, pinned]);

  return (
    <div
      className="addfile"
      onBlur={(e) => {
        // Close only when focus leaves the input and its list together, so Tab can reach the results.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label htmlFor="addfile" className="visually-hidden">
        Pin a file
      </label>
      <input
        id="addfile"
        className="addfile__input"
        placeholder="Pin a file…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            onPin(hits[0].path);
            setQ("");
          }
          if (e.key === "Escape") setOpen(false);
        }}
        autoComplete="off"
      />
      {open && hits.length > 0 && (
        <ul className="addfile__list" aria-label="Matching files">
          {hits.map((f) => (
            <li key={f.path}>
              <button
                className="addfile__hit mono"
                onClick={() => {
                  onPin(f.path);
                  setQ("");
                }}
              >
                {f.path}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
