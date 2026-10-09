import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt a value as JSON for storage: base64 of the IV, auth tag and ciphertext. */
export function encryptJson<T>(key: Buffer, value: T): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Decrypt what `encryptJson` stored. Throws if the key is wrong or the value was altered. */
export function decryptJson<T>(key: Buffer, stored: string): T {
  const bytes = Buffer.from(stored, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  const plaintext = Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
