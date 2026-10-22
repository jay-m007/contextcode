/**
 * Text utilities shared by indexing and search. No Node.js imports here: this
 * module also runs in the browser.
 */

/**
 * Words that carry no meaning for code search: English filler and the
 * keywords every JS/TS file contains.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our " +
    "so that the their them then there these they this to was we were what when where which while who why will with would you your " +
    "about all also any each just more most no not only other some such than too very use used using get gets work works happen happens " +
    "const let var function return import export default class extends new this true false null undefined void async await " +
    "type interface enum public private protected static readonly implements typeof instanceof else case switch break continue " +
    "handle handled handles handling implement implemented implementation set up way thing things code file files logic " +
    "try catch finally throw yield of in props children string number boolean any unknown never object react tsx jsx ts js src index"
  ).split(" "),
);

/** Splits "getUserSession", "get_user_session" and "get-user-session" into ["get", "user", "session"]. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * A light suffix stripper (a small subset of Porter stemming) so "sessions",
 * "authenticated" and "authenticate" meet on the same term. Being cautious is
 * deliberate: an over-eager stemmer merges unrelated words.
 */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.endsWith("es") && /(sh|ch|x|z|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

  if (/ations?$/.test(s) && s.replace(/ations?$/, "").length >= 3) s = s.replace(/ations?$/, "at"); // rotation -> rotat
  else if (/tions?$/.test(s) && s.length > 6) s = s.replace(/ions?$/, ""); //             selection -> select
  else if (s.endsWith("ing") && s.length > 5) s = trimDouble(s.slice(0, -3)); //            dragging -> drag
  else if (s.endsWith("ed") && s.length > 5) s = trimDouble(s.slice(0, -2)); //             rotated -> rotat
  if (s.endsWith("e") && s.length > 5) s = s.slice(0, -1); //                               rotate -> rotat
  return s;
}

/**
 * Programmers abbreviate; people asking questions don't. Both the code and the
 * question are mapped to the same short form, so "authentication" finds
 * auth.ts and "database" finds db.ts.
 */
const CANONICAL: [RegExp, string][] = [
  [/^(authent|authoriz|authn|authz|authenticat|authoris)/, "auth"],
  [/^(database|datastore)$/, "db"],
  [/^(configur|configs?$|cfg$|conf$)/, "config"],
  [/^(environment|env)$/, "env"],
  [/^(utilit|utils?$|helper)/, "util"],
  [/^(message|msg)$/, "message"],
  [/^(button|btn)$/, "button"],
  [/^(navigat|nav)$/, "nav"],
  [/^(image|img)$/, "image"],
  [/^(repositor|repo$)/, "repo"],
  [/^(request|req)$/, "request"],
  [/^(respons|res)$/, "response"],
  [/^(error|err)$/, "error"],
  [/^(paramet|params?$)/, "param"],
  [/^(argument|args?$)/, "arg"],
  [/^(signin|sign-in|logon)$/, "login"],
  [/^(signout|logoff)$/, "logout"],
  [/^(signup|registrat)/, "signup"],
  [/^(subscript|subscrib)/, "subscription"],
  [/^(payment|checkout|billing)$/, "billing"],
  [/^(permission|perm)$/, "permission"],
  [/^(initializ|initialis|init)$/, "init"],
  [/^(middleware|interceptor)$/, "middleware"],
];

/** The canonical form if a rule matches, else null. */
function canonical(w: string): string | null {
  for (const [re, to] of CANONICAL) if (re.test(w)) return to;
  return null;
}

function trimDouble(w: string): string {
  return /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w;
}

/**
 * Turns text into search terms. Identifiers are split into their words and
 * also kept whole (lowercased), so a query for "useSession" matches the exact
 * hook more strongly than files that merely mention "use" and "session".
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const words = text.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g) ?? [];
  for (const raw of words) {
    let t = cache.get(raw);
    if (!t) {
      t = wordTerms(raw);
      if (cache.size > 200_000) cache.clear(); // bound memory on huge repositories
      cache.set(raw, t);
    }
    for (const x of t) out.push(x);
  }
  return out;
}

/** Real code repeats the same identifiers constantly, so each word's terms are worked out once. */
const cache = new Map<string, string[]>();

function wordTerms(raw: string): string[] {
  const out: string[] = [];
  const word = raw.replace(/^[$_-]+|[$_-]+$/g, "");
  if (!word) return out;
  const parts = splitIdentifier(word);
  if (parts.length > 1) {
    const whole = parts.join("");
    if (whole.length >= 4 && whole.length <= 40) out.push(whole);
  }
  for (const p of parts) {
    if (p.length < 2 || p.length > 30 || STOPWORDS.has(p) || /^\d+$/.test(p)) continue;
    // Map whole words first ("database" -> "db", "image" -> "image"), then stems
    // ("authenticated" -> "authent" -> "auth"); otherwise the plain stem.
    const st = stem(p);
    out.push(canonical(p) ?? canonical(st) ?? st);
  }
  return out;
}

/**
 * Approximate token count. Real tokenizers average about 4 characters per
 * token on English and slightly fewer on code, so we use 3.6 for code. It is
 * deliberately a little pessimistic: going over a model's limit is worse than
 * leaving a few tokens unused.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Sentence-free utility: language tag for a fenced code block. */
export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", mts: "ts", cts: "ts", md: "md", mdx: "mdx" } as Record<string, string>)[ext] ?? "";
}
