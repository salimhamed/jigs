/** What the hub reads from its environment once, at startup. */
export interface HubConfig {
  host: string;
  port: number;
  /** The one base URL people and factories reach the hub at. */
  publicUrl: URL;
  databaseUrl: string;
  /** The AES-256 key every stored secret is encrypted with. */
  encryptionKey: Buffer;
  /** The sign-in app: the GitHub OAuth App people sign in to the hub with. */
  signInGithubClientId: string;
  signInGithubClientSecret: string;
  /** Whoever signs in with this GitHub email first creates the Organization. */
  adminEmail: string;
  /** How many days the hub keeps a factory's messages, confirmed or not. */
  retentionDays: number;
}

/** The Redirect URI the sign-in app needs on GitHub. */
export function signInRedirectUri(publicUrl: URL): string {
  return new URL("/api/auth/callback/github", publicUrl).href;
}

/** Read the hub's config, throwing one error that names every bad value. */
export function readConfig(env: NodeJS.ProcessEnv): HubConfig {
  const problems: string[] = [];
  const required = (name: string) => {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    problems.push(`PORT must be a port number, not ${env.PORT}`);
  }

  const publicUrlValue = required("HUB_PUBLIC_URL");
  const publicUrl = URL.parse(publicUrlValue);
  if (publicUrlValue && publicUrl === null) {
    problems.push(`HUB_PUBLIC_URL must be a URL, not ${publicUrlValue}`);
  } else if (publicUrl && publicUrl.href !== `${publicUrl.origin}/`) {
    problems.push(`HUB_PUBLIC_URL must be an origin with no path, not ${publicUrlValue}`);
  }

  const databaseUrl = required("HUB_DATABASE_URL");

  const encryptionKey = Buffer.from(required("HUB_ENCRYPTION_KEY"), "base64");
  if (env.HUB_ENCRYPTION_KEY && encryptionKey.length !== 32) {
    problems.push("HUB_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)");
  }

  const signInGithubClientId = required("HUB_SIGN_IN_GITHUB_CLIENT_ID");
  const signInGithubClientSecret = required("HUB_SIGN_IN_GITHUB_CLIENT_SECRET");
  const adminEmail = required("HUB_ADMIN_EMAIL");

  const retentionDays = Number(env.HUB_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    problems.push(
      `HUB_RETENTION_DAYS must be a whole number of days, not ${env.HUB_RETENTION_DAYS}`,
    );
  }

  if (problems.length > 0) {
    let message = `The hub cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`;
    const publicUrlIsValid = publicUrl && !problems.some((p) => p.startsWith("HUB_PUBLIC_URL"));
    if (publicUrlIsValid && (!signInGithubClientId || !signInGithubClientSecret)) {
      message += [
        "\n\nCreate the sign-in app on GitHub under Developer settings → OAuth Apps, with:",
        `  Homepage URL: ${publicUrl.origin}`,
        `  Redirect URI: ${signInRedirectUri(publicUrl)}`,
      ].join("\n");
    }
    throw new Error(message);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    publicUrl: publicUrl as URL,
    databaseUrl,
    encryptionKey,
    signInGithubClientId,
    signInGithubClientSecret,
    adminEmail,
    retentionDays,
  };
}
