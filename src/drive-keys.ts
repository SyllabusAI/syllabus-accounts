/**
 * Rotating DRIVE_KEY without anybody reconnecting Drive.
 *
 * Every stored Drive refresh token is sealed under DRIVE_KEY (crypto.ts).
 * Changing that secret used to make every grant unreadable at once. Now a
 * rotation is two secrets for a while:
 *
 *   DRIVE_KEY            the key everything is sealed under from now on
 *   DRIVE_KEY_PREVIOUS   the key being retired, only ever used to open
 *
 * A grant is opened with whichever key its key id names (or, for a value
 * sealed before key ids, current then previous), and one that was not sealed
 * under the current key is sealed again under it on the spot. The hourly
 * sweep (sweepDriveGrants, from the Worker's scheduled handler) does the same
 * for grants nobody is using, so the previous key can be deleted once the
 * sweep reports nothing left. docs/drive-key-rotation.md is the procedure.
 */

import { decrypt, encrypt, keyId, sealedKeyId } from "./crypto";
import type { DriveGrant } from "./db";
import type { Bindings } from "./env";

type Keys = Pick<Bindings, "DB" | "DRIVE_KEY" | "DRIVE_KEY_PREVIOUS">;

/** Seal a refresh token under the current key. */
export async function sealGrant(env: Pick<Bindings, "DRIVE_KEY">, refreshToken: string): Promise<string> {
  return encrypt(env.DRIVE_KEY, refreshToken);
}

/**
 * The plain refresh token, from a sealed value, and whether it needs sealing
 * again under the current key. Throws when neither key opens it.
 */
export async function unseal(env: Omit<Keys, "DB">, sealed: string): Promise<{ plain: string; stale: boolean }> {
  const current = env.DRIVE_KEY;
  const previous = env.DRIVE_KEY_PREVIOUS || "";
  const named = sealedKeyId(sealed);
  const currentId = await keyId(current);
  let order: string[];
  if (named === currentId) order = [current];
  else if (previous && named === (await keyId(previous))) order = [previous];
  // Sealed before key ids, or under a key id we do not recognize: try both.
  else order = previous ? [current, previous] : [current];

  let failure: unknown = null;
  for (const secret of order) {
    try {
      const plain = await decrypt(secret, sealed);
      return { plain, stale: secret !== current || named !== currentId };
    } catch (err) {
      failure = err;
    }
  }
  throw failure instanceof Error ? failure : new Error("the grant opens under neither key");
}

/**
 * Open an account's grant, sealing it again under the current key when it
 * was not already. The rewrite is conditional on the row still holding what
 * was read, so a grant replaced in the meantime is never overwritten.
 */
export async function openGrant(env: Keys, grant: Pick<DriveGrant, "account_id" | "refresh_token_enc">): Promise<string> {
  const { plain, stale } = await unseal(env, grant.refresh_token_enc);
  if (stale) await reseal(env, grant.account_id, grant.refresh_token_enc, plain);
  return plain;
}

async function reseal(env: Keys, accountId: string, was: string, plain: string): Promise<boolean> {
  const sealed = await sealGrant(env, plain);
  const res = await env.DB.prepare(
    "UPDATE drive_grants SET refresh_token_enc = ? WHERE account_id = ? AND refresh_token_enc = ?",
  )
    .bind(sealed, accountId, was)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export type SweepResult = { resealed: number; unreadable: number; remaining: number };

/**
 * Seal every grant that is not under the current key again under it.
 *
 * Bounded per run so a scheduled invocation cannot run away; whatever it
 * does not reach, the next run does. A grant neither key opens is counted
 * and left alone: it is either sealed under a key that is already gone, in
 * which case its owner reconnects Drive, or somebody has to go and look.
 * `remaining` is how many grants are still not under the current key after
 * this run, which is the number the rotation procedure waits to reach zero.
 */
export async function sweepDriveGrants(env: Keys, maxRows = 500): Promise<SweepResult> {
  const suffix = "%." + (await keyId(env.DRIVE_KEY));
  let resealed = 0;
  let unreadable = 0;
  let after = "";
  let seen = 0;
  while (seen < maxRows) {
    const { results } = await env.DB.prepare(
      `SELECT account_id, refresh_token_enc FROM drive_grants
       WHERE account_id > ? AND refresh_token_enc NOT LIKE ?
       ORDER BY account_id LIMIT 100`,
    )
      .bind(after, suffix)
      .all<Pick<DriveGrant, "account_id" | "refresh_token_enc">>();
    if (!results.length) break;
    for (const row of results) {
      seen += 1;
      after = row.account_id;
      try {
        const { plain } = await unseal(env, row.refresh_token_enc);
        if (await reseal(env, row.account_id, row.refresh_token_enc, plain)) resealed += 1;
      } catch {
        unreadable += 1;
      }
    }
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM drive_grants WHERE refresh_token_enc NOT LIKE ?")
    .bind(suffix)
    .first<{ n: number }>();
  return { resealed, unreadable, remaining: left?.n ?? 0 };
}
