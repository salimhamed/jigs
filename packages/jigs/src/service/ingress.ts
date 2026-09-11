// Ingress verification: every inbound delivery is HMAC-verified against the
// raw body before anything is parsed, and wakes are hints only — the
// suspension primitives re-check provider state on every wake.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { githubWebhookSecretFile } from "../config/paths.ts";

function hmacMatches(rawBody: string, signatureHex: string, secret: string) {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Buffer.from(_, "hex") stops at the first invalid pair, so malformed hex
  // fails the length guard rather than reaching timingSafeEqual.
  const given = Buffer.from(signatureHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// GitHub: `x-hub-signature-256: sha256=<hex hmac of the raw body>`.
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  return hmacMatches(rawBody, signatureHeader.slice("sha256=".length), secret);
}

// Linear: `linear-signature: <hex hmac of the raw body>`, no prefix.
export function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined) return false;
  return hmacMatches(rawBody, signatureHeader, secret);
}

// The env override is the test seam and the non-default deploy path; the file
// is where `jigs bind` generates the shared per-repo webhook secret.
export function githubWebhookSecret(): string | null {
  const env = process.env.GITHUB_WEBHOOK_SECRET;
  if (env !== undefined && env !== "") return env;
  const file = githubWebhookSecretFile();
  try {
    const secret = readFileSync(file, "utf8").trim();
    return secret === "" ? null : secret;
  } catch {
    return null;
  }
}
