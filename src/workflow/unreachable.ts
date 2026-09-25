// The default arm of an exhaustive switch. The parameter's `never` type is the
// real guard — it makes a newly added union member a typecheck failure at the
// call site — and the value is stringified so a member that reaches here at run
// time names itself.
/**
 * Fail an exhaustive branch if an unexpected value reaches it at runtime.
 *
 * @group Errors and utilities
 */
export function unreachable(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
