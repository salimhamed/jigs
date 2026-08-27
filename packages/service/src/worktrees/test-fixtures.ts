import type { Sql } from "postgres";
import type { WorktreeRow } from "./registry";

// Fakes the postgres tagged-template client against an in-memory store,
// discriminating exactly as registry.ts's queries do. Anything it does not
// recognise — notably the advisory-lock SELECT, which must not read as a
// registry query — resolves empty.
export function makeFakeSql(store: Map<string, WorktreeRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("$").trimStart();
    // DELETE also reads FROM jigs_worktrees, so the verb decides first.
    if (
      statement.startsWith("SELECT") &&
      statement.includes("jigs_worktrees")
    ) {
      // No interpolation is listWorktrees; the real one orders by recency,
      // which insertion order stands in for here.
      if (values.length === 0) return Promise.resolve([...store.values()]);
      const row = store.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (statement.startsWith("INSERT")) {
      const [
        path,
        branch,
        ownerRunId,
        state,
        baseSha,
        headSha,
        behindDefault,
        checkoutRoot,
        keep,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        boolean,
      ];
      store.set(path, {
        path,
        branch,
        ownerRunId,
        state,
        baseSha,
        headSha,
        behindDefault,
        checkoutRoot,
        keep,
      });
      return Promise.resolve([]);
    }
    if (statement.startsWith("UPDATE")) {
      const [state, path] = values as [string, string];
      const row = store.get(path);
      if (row !== undefined) store.set(path, { ...row, state });
      return Promise.resolve([]);
    }
    if (statement.startsWith("DELETE")) {
      store.delete(values[0] as string);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.begin = (fn: (sql: unknown) => unknown) => Promise.resolve(fn(sql));
  return sql as unknown as Sql;
}
