import {
  Node,
  type ObjectLiteralExpression,
  Project,
  type PropertyAssignment,
  type StringLiteral,
  SyntaxKind,
  ts,
} from "ts-morph";
import { JigsError } from "../errors.ts";
import { FACTORY_CONFIG_FILE } from "./factory-config.ts";

function propertyName(property: PropertyAssignment): string {
  const node = property.getNameNode();
  return Node.isStringLiteral(node) || Node.isNumericLiteral(node)
    ? String(node.getLiteralValue())
    : property.getName();
}

function namedProperty(
  object: ObjectLiteralExpression,
  name: string,
): PropertyAssignment | undefined {
  return object
    .getProperties()
    .find((property) => Node.isPropertyAssignment(property) && propertyName(property) === name) as
    | PropertyAssignment
    | undefined;
}

const reservedWords = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(
    " ",
  ),
);

function bindingPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !reservedWords.has(name)
    ? name
    : JSON.stringify(name);
}

function leadingWhitespace(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return text.slice(lineStart, position).match(/^\s*/)?.[0] ?? "";
}

function insertBinding(
  text: string,
  object: ObjectLiteralExpression,
  bindingsProperty: PropertyAssignment,
  name: string,
  remote: string,
): string {
  const entry = `${bindingPropertyName(name)}: { remote: ${JSON.stringify(remote)} },`;
  const properties = object.getProperties();
  if (properties.length === 0) {
    const propertyIndent = leadingWhitespace(text, bindingsProperty.getStart());
    const indentation = propertyIndent || "  ";
    return `${text.slice(0, object.getStart())}{\n${propertyIndent}${indentation}${entry}\n${propertyIndent}}${text.slice(object.getEnd())}`;
  }

  const first = properties[0] as PropertyAssignment;
  const last = properties.at(-1) as PropertyAssignment;
  const entryIndent = leadingWhitespace(text, first.getStart());
  const closeBrace = object.getEnd() - 1;
  const closeLineStart = text.lastIndexOf("\n", closeBrace - 1) + 1;
  if (closeLineStart <= last.getEnd()) {
    const separator = text.slice(last.getEnd(), closeBrace).includes(",") ? "" : ",";
    return `${text.slice(0, last.getEnd())}${separator}${text.slice(last.getEnd(), closeBrace)}${entry} ${text.slice(closeBrace)}`;
  }
  const separator = text.slice(last.getEnd(), closeLineStart).includes(",") ? "" : ",";
  return `${text.slice(0, last.getEnd())}${separator}${text.slice(last.getEnd(), closeLineStart)}${entryIndent}${entry}\n${text.slice(closeLineStart)}`;
}

// Editing deliberately supports the scaffold's direct object shape. Runtime
// loading is unrestricted; an unsupported edit never writes or registers hooks.
function editableBindings(text: string, manualEdit?: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const source = project.createSourceFile(FACTORY_CONFIG_FILE, text);
  const fail = (reason: string): never => {
    throw new JigsError(
      `Cannot edit bindings in ${FACTORY_CONFIG_FILE}: ${reason}.`,
      `Declare bindings directly as an object in export default defineFactory({ bindings: { ... } }) to use jigs bind or jigs unbind, or edit the binding manually. No files were changed.${manualEdit ? `\n${manualEdit}` : ""}`,
    );
  };
  const diagnostics = source
    .getPreEmitDiagnostics()
    .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error && d.getCode() < 2000);
  if (diagnostics.length) fail("the file contains invalid TypeScript syntax");
  const exports = source.getExportAssignments();
  if (exports.length !== 1) fail("expected one default export");
  let expression: Node | undefined = exports[0]?.getExpression();
  if (expression && Node.isCallExpression(expression)) {
    if (
      expression.getExpression().getText() !== "defineFactory" ||
      expression.getArguments().length !== 1
    )
      fail("expected defineFactory with one object argument");
    expression = expression.getArguments()[0];
  }
  if (!expression || !Node.isObjectLiteralExpression(expression))
    fail("the default configuration is not a direct object");
  const root = expression as ObjectLiteralExpression;
  const validate = (object: ObjectLiteralExpression, label: string) => {
    const names = new Set<string>();
    for (const property of object.getProperties()) {
      if (!Node.isPropertyAssignment(property))
        fail(`${label} contains a spread, shorthand, or method`);
      const assignment = property as PropertyAssignment;
      if (Node.isComputedPropertyName(assignment.getNameNode()))
        fail(`${label} contains a computed property name`);
      const name = propertyName(assignment);
      if (names.has(name)) fail(`${label} contains duplicate property ${name}`);
      names.add(name);
    }
  };
  validate(root, "the configuration object");
  let property = namedProperty(root, "bindings");
  const insertedBindings = !property;
  if (!property)
    property = root.addPropertyAssignment({
      name: "bindings",
      initializer: "{}",
    });
  const bindings = (property as PropertyAssignment).getInitializer();
  if (!bindings || !Node.isObjectLiteralExpression(bindings))
    fail(
      "bindings is not a direct object (for example, it may be a function call or imported value)",
    );
  const object = bindings as ObjectLiteralExpression;
  validate(object, "bindings");
  for (const property of object.getProperties()) {
    const initializer = (property as PropertyAssignment).getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer))
      fail(`binding ${(property as PropertyAssignment).getName()} is not a direct object`);
    validate(
      initializer as ObjectLiteralExpression,
      `binding ${(property as PropertyAssignment).getName()}`,
    );
  }
  return {
    source,
    object,
    property: property as PropertyAssignment,
    insertedBindings,
    fail,
  };
}

export function upsertBinding(text: string, name: string, remote: string): string {
  const {
    source,
    object,
    property: bindingsProperty,
    insertedBindings,
    fail,
  } = editableBindings(
    text,
    `Binding to add: ${JSON.stringify(name)}: { remote: ${JSON.stringify(remote)} }`,
  );
  const property = namedProperty(object, name) as PropertyAssignment | undefined;
  if (!property) {
    if (insertedBindings) {
      object.addPropertyAssignment({
        name: bindingPropertyName(name),
        initializer: `{ remote: ${JSON.stringify(remote)} }`,
      });
      return source.getFullText();
    }
    return insertBinding(text, object, bindingsProperty, name, remote);
  } else {
    const binding = property.getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const remoteProperty = namedProperty(binding, "remote") as PropertyAssignment | undefined;
    if (remoteProperty) {
      const value = remoteProperty.getInitializer();
      if (!value || !Node.isStringLiteral(value))
        fail(`binding ${name}'s remote is not a string literal`);
      if ((value as StringLiteral).getLiteralValue() === remote) return text;
      remoteProperty.setInitializer(JSON.stringify(remote));
    } else
      binding.addPropertyAssignment({
        name: "remote",
        initializer: JSON.stringify(remote),
      });
  }
  return source.getFullText();
}

export function removeBinding(text: string, name: string): string {
  const { source, object } = editableBindings(text);
  const property = namedProperty(object, name);
  if (!property) throw new JigsError(`no binding named ${name}`);
  property.remove();
  return source.getFullText();
}
