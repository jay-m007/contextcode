import ts from "typescript";
import type { ImportKind, RawImport } from "./types.js";

/** Picks the TypeScript parser mode from the file extension. */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Extracts every module reference from one file's source text.
 *
 * We parse the file into an Abstract Syntax Tree with the TypeScript compiler
 * (which also understands plain JavaScript and JSX), then walk the tree looking
 * for the node types that reference other modules. Working on the AST instead
 * of using regular expressions means comments, strings that merely *look* like
 * imports, and unusual formatting cannot fool us.
 */
export function extractImports(fileName: string, sourceText: string): RawImport[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const found: RawImport[] = [];
  // If the file defines its own `require` (variable, function or parameter),
  // calls to it are not CommonJS imports. A whole-file check is a deliberate
  // simplification of real scope analysis; local `require` shadowing is rare.
  const requireIsShadowed = declaresName(sf, "require");

  const add = (node: ts.Node, specifier: string, kind: ImportKind, typeOnly: boolean) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ specifier, kind, typeOnly, line: line + 1 });
  };

  const visit = (node: ts.Node): void => {
    // import x from "./x";  import { a, type B } from "./x";  import type T from "./x";  import "./x";
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) {
        add(node, node.moduleSpecifier.text, "side-effect", false);
      } else {
        add(node, node.moduleSpecifier.text, "static", isTypeOnlyImportClause(clause));
      }
    }

    // export * from "./x";  export { a } from "./x";  export type { T } from "./x";
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node, node.moduleSpecifier.text, "re-export", node.isTypeOnly || isTypeOnlyExportClause(node));
    }

    // import x = require("./x");
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text, "import-equals", node.isTypeOnly);
    }

    // type T = import("./x").T
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node, node.argument.literal.text, "import-type", true);
    }

    // import("./x")  and  require("./x")
    else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const arg = node.arguments[0];
      const literal = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
      if (literal !== null) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          add(node, literal, "dynamic", false);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && !requireIsShadowed) {
          add(node, literal, "require", false);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** True if the file declares a variable, function, parameter or import binding called `name`. */
function declaresName(sf: ts.SourceFile, name: string): boolean {
  if (!sf.text.includes(name)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) ||
        ts.isImportSpecifier(node) || ts.isImportClause(node)) &&
      node.name && ts.isIdentifier(node.name) && node.name.text === name
    ) {
      // `const require = createRequire(import.meta.url)` is the ESM way to get a REAL require.
      const isCreateRequire =
        ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        /createRequire$/.test(node.initializer.expression.getText(sf));
      if (!isCreateRequire) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** `import type X` or `import { type A, type B }` (every binding is type-only). */
function isTypeOnlyImportClause(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // a default value import
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
}

/** `export { type A, type B } from "./x"`. */
function isTypeOnlyExportClause(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}
