// The two Slack tokens a Slack-enabled factory keeps in its own .env, named
// once: the startup gate refuses without them and doctor checks their shape,
// and those are different modules. The model credential is not here — it
// belongs to whichever provider model.ts talks to, and lives with it.

export const SLACK_BOT_TOKEN = "SLACK_BOT_TOKEN";
export const SLACK_APP_TOKEN = "SLACK_APP_TOKEN";

/** Slack's own prefixes. A bot token pasted into the app-token slot is the
 *  mistake worth naming, and the prefix is what tells them apart. */
export const BOT_TOKEN_PREFIX = "xoxb-";
export const APP_TOKEN_PREFIX = "xapp-";
