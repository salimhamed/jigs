const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Inert by omission: sandcastle's `` !`cmd` `` shell-command half is
// deliberately not ported, so there is nothing an unknown key could trigger —
// it stays verbatim rather than throwing. One pass with a function callback
// means substituted values are never rescanned, which is what makes ticket
// text (braces and all) safe to embed.
/**
 * Replace named `{{ placeholders }}` once, leaving unknown names unchanged.
 *
 * @group Errors and utilities
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] as string) : match,
  );
}
