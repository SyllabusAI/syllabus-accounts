/** AES-GCM under DRIVE_KEY, for the one secret we keep on behalf of a person. */

import { fromBase64Url, toBase64Url } from "./util";

async function key(secret: string): Promise<CryptoKey> {
  // Any string works as the secret; it is hashed to 256 bits first.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(text));
  return toBase64Url(iv) + "." + toBase64Url(new Uint8Array(box));
}

export async function decrypt(secret: string, sealed: string): Promise<string> {
  const [ivText, boxText] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivText) },
    await key(secret),
    fromBase64Url(boxText),
  );
  return new TextDecoder().decode(plain);
}

/**
 * The one identifier kept after an account is deleted: a keyed hash of the
 * Google `sub`, so a repeat free trial can be recognized and nothing else can
 * be learned. See migrations/0013_trial_used.sql.
 *
 * HMAC-SHA256 under a key derived from SESSION_SECRET with its own label, so
 * the value is useless without the Worker's secret and is never the same
 * bytes as anything the session cookie signs. Hex, 64 characters.
 */
export async function trialHash(sessionSecret: string, sub: string): Promise<string> {
  const derived = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("syllabus trial-used key v1\n" + sessionSecret),
  );
  const hmacKey = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(sub));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
