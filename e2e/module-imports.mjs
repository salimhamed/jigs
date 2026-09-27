import { ts } from "ts-morph";

// JSDoc examples and generated template strings can contain import syntax too.
// Only module declarations create the static dependency edges this gate follows.
export function staticModuleSpecifiers(source) {
  const module = ts.createSourceFile(
    "bundle.js",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  return module.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    const specifier = statement.moduleSpecifier;
    return specifier && ts.isStringLiteral(specifier) ? [specifier.text] : [];
  });
}
