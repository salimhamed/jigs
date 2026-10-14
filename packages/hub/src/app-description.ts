// No server imports: the web app's pages import this too.

/** The longest description an app can have. */
export const appDescriptionLength = 200;

/** A description as stored: `null` when empty. */
export function appDescription(text = ""): { description: string | null } | { error: string } {
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > appDescriptionLength) {
    return { error: `Keep the description to ${appDescriptionLength} characters.` };
  }
  return { description: text || null };
}
