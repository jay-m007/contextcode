"use client";

import { useState } from "react";
import type { Pack, Tier } from "@contextcode/core/engine";

const TIER_LABEL: Record<Tier, string> = { full: "Full file", focused: "Focused", outline: "Outline" };

/**
 * The token budget drawn as a packed bar: one segment per included file,
 * width proportional to its tokens, texture showing its detail level. The bar
 * is the budget; anything past the end line is over budget.
 */
export function BudgetMeter({ pack }: { pack: Pack }) {
  const [hover, setHover] = useState<number | null>(null);
  const over = pack.tokens > pack.budget;
  const scale = Math.max(pack.budget, pack.tokens);
  const pct = (n: number) => `${(n / scale) * 100}%`;
  const counts = (["full", "focused", "outline"] as Tier[]).map((t) => [t, pack.files.filter((f) => f.tier === t).length] as const);
  const h = hover !== null ? pack.files[hover] : null;

  return (
    <div className="meter" aria-label="Token budget">
      <div className="meter__numbers">
        <span className="meter__used mono">{pack.tokens.toLocaleString()}</span>
        <span className="meter__of">
          of {pack.budget.toLocaleString()} tokens, {pack.files.length} {pack.files.length === 1 ? "file" : "files"}
        </span>
        {over && <span className="meter__over">{(pack.tokens - pack.budget).toLocaleString()} over budget</span>}
      </div>

      <div className="meter__bar" role="img" aria-label={`${pack.tokens} of ${pack.budget} tokens used by ${pack.files.length} files`}>
        {pack.files.map((f, i) => (
          <span
            key={f.path}
            className={`seg seg--${f.tier}${hover === i ? " seg--hover" : ""}`}
            style={{ width: pct(f.tokens) }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {over && <span className="meter__limit" style={{ left: pct(pack.budget) }} aria-hidden="true" />}
      </div>

      <div className="meter__foot">
        {h ? (
          <span className="meter__hover">
            <span className="mono">{h.path}</span> · {TIER_LABEL[h.tier]} · {h.tokens.toLocaleString()} tokens
          </span>
        ) : (
          <ul className="legend" aria-label="Detail levels">
            {counts.map(([t, n]) => (
              <li key={t}>
                <span className={`swatch seg--${t}`} aria-hidden="true" />
                {TIER_LABEL[t]} <span className="muted">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
