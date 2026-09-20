/** @packageDocumentation */

/** A documented interface whose signature explains its fields. */
export interface DocumentedContainer {
  undocumentedNestedMember: string;
}

export function undocumentedDirectExport(): { undocumentedInlineMember: string } {
  return { undocumentedInlineMember: "value" };
}

export { default as documentedDefault, documentedTarget } from "./summary-target.ts";
