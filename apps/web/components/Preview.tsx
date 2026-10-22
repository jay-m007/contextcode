"use client";

import { useMemo, useState } from "react";
import type { Format } from "@contextcode/core/engine";
import { highlight } from "@/lib/highlight";

/**
 * Exactly the text that will be copied, with the question's words highlighted.
 * What you see is what the AI gets.
 */
export function Preview(props: { output: string; fmt: Format; onFormat: (f: Format) => void; qTerms: Set<string>; project: string; hasQuery: boolean }) {
  const [copied, setCopied] = useState(false);
  const segments = useMemo(() => highlight(props.output, props.qTerms), [props.output, props.qTerms]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const ext = props.fmt === "xml" ? "xml" : props.fmt === "json" ? "json" : "md";
    const url = URL.createObjectURL(new Blob([props.output], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.project}-context.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="preview">
      <div className="preview__bar">
        <div className="segmented" role="radiogroup" aria-label="Output format">
          {(["markdown", "xml", "json"] as Format[]).map((f) => (
            <button key={f} role="radio" aria-checked={props.fmt === f} onClick={() => props.onFormat(f)}>
              {f === "markdown" ? "Markdown" : f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="preview__actions">
          <button className="btn" onClick={download} disabled={!props.output}>
            Download
          </button>
          <button className="btn btn--primary" onClick={copy} disabled={!props.output}>
            {copied ? "Copied" : "Copy context"}
          </button>
        </div>
      </div>
      <span className="visually-hidden" role="status">
        {copied ? "Context copied to the clipboard" : ""}
      </span>
      {props.output ? (
        <pre className="preview__text" tabIndex={0} aria-label="Packed context">
          {segments.map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : s.text))}
        </pre>
      ) : (
        <div className="preview__empty">
          <p>{props.hasQuery ? "Nothing fits yet. Raise the budget or pin a file." : "Ask a question on the left. The context you'd paste into an AI assistant appears here."}</p>
        </div>
      )}
    </div>
  );
}
