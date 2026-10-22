import { terms } from "@contextcode/core/engine";

export type Segment = { text: string; mark: boolean };

/**
 * Splits text into plain and highlighted runs: a word is highlighted when any
 * of its search terms is one of the question's terms, so "rotated" in the
 * question marks rotateElement() in the code.
 */
export function highlight(text: string, qTerms: Set<string>): Segment[] {
  if (qTerms.size === 0) return [{ text, mark: false }];
  const out: Segment[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let last = 0;
  const cache = new Map<string, boolean>();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[0];
    let hit = cache.get(w);
    if (hit === undefined) {
      hit = terms(w).some((t) => qTerms.has(t));
      cache.set(w, hit);
    }
    if (!hit) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), mark: false });
    out.push({ text: w, mark: true });
    last = m.index + w.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false });
  return out;
}
