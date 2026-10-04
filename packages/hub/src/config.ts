/** What the hub reads from its environment once, at startup. */
export interface HubConfig {
  host: string;
  port: number;
  /** The one base URL people and factories reach the hub at. */
  publicUrl: URL;
  databaseUrl: string;
  /** The AES-256 key every stored secret is encrypted with. */
  encryptionKey: Buffer;
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
  }

  const databaseUrl = required("HUB_DATABASE_URL");

  const encryptionKey = Buffer.from(required("HUB_ENCRYPTION_KEY"), "base64");
  if (env.HUB_ENCRYPTION_KEY && encryptionKey.length !== 32) {
    problems.push("HUB_ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)");
  }

  if (problems.length > 0) {
    throw new Error(`The hub cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    publicUrl: publicUrl as URL,
    databaseUrl,
    encryptionKey,
  };
}
