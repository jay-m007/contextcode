import ts from "typescript";
import type { CodeSymbol, SymbolKind } from "./types.js";

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Lists the top-level declarations of a JS/TS file (and the methods of its
 * classes) with their line ranges and signatures.
 *
 * Signatures are what let ContextCode send an "outline" of a file: every
 * function's name, parameters and return type, without the bodies, at a
 * fraction of the tokens.
 */
export function extractSymbols(fileName: string, text: string, parsed?: ts.SourceFile): CodeSymbol[] {
  const sf = parsed ?? ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const out: CodeSymbol[] = [];
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const push = (node: ts.Node, name: string, kind: SymbolKind, exported: boolean, parent?: string) => {
    const start = node.getStart(sf, true); // include the JSDoc comment above, so focused views keep it
    out.push({
      name,
      kind,
      exported,
      startLine: line(start),
      endLine: line(node.getEnd()),
      signature: signatureOf(node, sf),
      doc: docOf(node, sf),
      parent,
    });
  };

  for (const stmt of sf.statements) {
    const exported = isExported(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      push(stmt, stmt.name.text, looksLikeComponent(stmt.name.text, stmt) ? "component" : "function", exported);
    } else if (ts.isClassDeclaration(stmt)) {
      const className = stmt.name?.text ?? "default";
      push(stmt, className, "class", exported);
      for (const m of stmt.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name && !ts.isComputedPropertyName(m.name)) {
          push(m, m.name.getText(sf), "method", exported, className);
        } else if (ts.isConstructorDeclaration(m)) {
          push(m, "constructor", "method", exported, className);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      push(stmt, stmt.name.text, "interface", exported);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      push(stmt, stmt.name.text, "type", exported);
    } else if (ts.isEnumDeclaration(stmt)) {
      push(stmt, stmt.name.text, "enum", exported);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || isWrappedFunction(init));
        const kind: SymbolKind = isFn ? (looksLikeComponent(name, init!) ? "component" : "function") : "variable";
        // Attach the range to the whole statement so `export const` and the JSDoc above stay together.
        const sym = { node: stmt.declarationList.declarations.length === 1 ? stmt : decl };
        push(sym.node, name, kind, exported);
      }
    } else if (ts.isExportAssignment(stmt)) {
      // export default <expression>
      const expr = stmt.expression;
      const name = ts.isIdentifier(expr) ? expr.text : "default";
      if (!ts.isIdentifier(expr)) push(stmt, name, ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) ? "function" : "variable", true);
    }
  }
  return out;
}

/**
 * Splits a Markdown document into heading sections, so a long README can be
 * searched and included one section at a time.
 */
export function extractSections(text: string): CodeSymbol[] {
  const lines = text.split("\n");
  const out: CodeSymbol[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) {
      if (out.length) out[out.length - 1].endLine = i; // previous section ends on the line before
      out.push({ name: m[2], kind: "section", exported: true, startLine: i + 1, endLine: lines.length, signature: l.trim() });
    }
  }
  if (out.length === 0 && text.trim()) {
    out.push({ name: "(document)", kind: "section", exported: true, startLine: 1, endLine: lines.length, signature: lines.find((l) => l.trim()) ?? "" });
  }
  return out;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** `memo(() => ...)`, `forwardRef(function X() {...})`, `useCallback(...)` and similar wrappers. */
function isWrappedFunction(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  return node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
}

function looksLikeComponent(name: string, node: ts.Node): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  let jsx = false;
  const visit = (n: ts.Node) => {
    if (jsx) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) jsx = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return jsx;
}

/**
 * The declaration's text up to (not including) its body. For a variable whose
 * value is a function, that is everything up to the arrow's body; for other
 * variables it is the first line, trimmed to a reasonable length.
 */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf, false);
  let end = node.getEnd();

  const body = bodyOf(node);
  if (body) end = body.getStart(sf);

  let sig = sf.text.slice(start, end).trim();
  if (!body && (ts.isVariableStatement(node) || ts.isVariableDeclaration(node))) {
    sig = sig.split("\n")[0];
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    // Types are their own signature, but cap very long ones.
    const full = sf.text.slice(start, node.getEnd()).trim();
    sig = full.split("\n").length <= 12 ? full : full.split("\n").slice(0, 12).join("\n") + "\n  // ...";
    return sig;
  }
  sig = sig.replace(/\s*[{=]?\s*$/, "").replace(/\s*=>\s*$/, " =>");
  return sig.length > 400 ? sig.slice(0, 400) + " …" : sig;
}

function bodyOf(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) || ts.isSetAccessor(node)) return node.body;
  if (ts.isClassDeclaration(node)) {
    // Up to the opening brace of the class body.
    const brace = node.getChildren().find((c) => c.kind === ts.SyntaxKind.OpenBraceToken);
    return brace;
  }
  const decl = ts.isVariableStatement(node) ? node.declarationList.declarations[0] : ts.isVariableDeclaration(node) ? node : undefined;
  const init = decl?.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
  if (init && ts.isCallExpression(init)) {
    const fn = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as ts.ArrowFunction | ts.FunctionExpression | undefined;
    return fn?.body;
  }
  if (ts.isExportAssignment(node)) {
    const e = node.expression;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e.body;
  }
  return undefined;
}

function docOf(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  const jsdoc = ranges?.filter((r) => sf.text.startsWith("/**", r.pos)).pop();
  if (!jsdoc) return undefined;
  const raw = sf.text
    .slice(jsdoc.pos + 3, jsdoc.end - 2)
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .filter((l) => !l.startsWith("@"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return undefined;
  const first = raw.match(/^.+?[.!?](\s|$)/)?.[0] ?? raw;
  return first.trim().slice(0, 240);
}
