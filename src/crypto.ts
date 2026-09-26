/**
 * AES-GCM under DRIVE_KEY, for the one secret we keep on behalf of a person.
 *
 * A sealed value is `<iv>.<box>.<key id>`, each part base64url except the key
 * id, which is 8 hex characters naming the key that sealed it (keyId below).
 * Values sealed before key ids existed are `<iv>.<box>` and still open.
 *
 * The key id goes LAST on purpose: code from before it existed splits on "."
 * and reads the first two parts, so it still opens a value sealed here. A
 * rollback past this change therefore does not strand any grant.
 */

import { fromBase64Url, sha256Hex, toBase64Url } from "./util";

async function key(secret: string): Promise<CryptoKey> {
  // Any string works as the secret; it is hashed to 256 bits first.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * A short public name for a key, so a sealed value says which key opens it.
 *
 * A hash of a labeled copy of the secret, never the hash the AES key is made
 * from. 32 bits of it tell a guesser nothing a ciphertext's own GCM tag does
 * not already. An operator gets the same value with
 *   printf 'syllabus-drive-key-id:%s' "$KEY" | shasum -a 256 | cut -c1-8
 */
export async function keyId(secret: string): Promise<string> {
  return (await sha256Hex("syllabus-drive-key-id:" + secret)).slice(0, 8);
}

/** The key id a sealed value names, or "" for a value sealed before key ids. */
export function sealedKeyId(sealed: string): string {
  return sealed.split(".")[2] ?? "";
}

export async function encrypt(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(text));
  return toBase64Url(iv) + "." + toBase64Url(new Uint8Array(box)) + "." + (await keyId(secret));
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
