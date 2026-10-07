/** Values as code, joined as "a, b and c". */
export function Codes({ values }: { values: readonly string[] }) {
  return values.map((value, index) => (
    <span key={value}>
      {index === 0 ? "" : index === values.length - 1 ? " and " : ", "}
      <code>{value}</code>
    </span>
  ));
}
