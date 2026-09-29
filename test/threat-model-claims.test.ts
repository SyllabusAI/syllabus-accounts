import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt, keyId, sealedKeyId } from "../src/crypto";
import { openGrant, sweepDriveGrants } from "../src/drive-keys";
import { claimDevice, ORIGIN, signedInAs } from "./helpers";

/**
 * Claims made in docs/threat-model-0.6.md and docs/drive-key-rotation.md that
 * are worth a test of their own. Nothing here changes the service.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- DRIVE_KEY rotation: the parts of the runbook no other test walks ---------

describe("the DRIVE_KEY runbook (docs/drive-key-rotation.md)", () => {
  async function grantRow(sealed: string) {
    const { account } = await signedInAs(`runbook-${Math.random().toString(36).slice(2)}@example.com`);
    await env.DB.prepare(
      "INSERT INTO drive_grants (account_id, refresh_token_enc, scopes, google_email, granted_at) VALUES (?, ?, 'drive.file', '', '2026-01-01')",
    )
      .bind(account.id, sealed)
      .run();
    return account.id;
  }

  async function sealedOf(accountId: string) {
    return (await env.DB.prepare("SELECT refresh_token_enc FROM drive_grants WHERE account_id = ?")
      .bind(accountId)
      .first<{ refresh_token_enc: string }>())!.refresh_token_enc;
  }

  it("computes the same key id in the shell as the Worker does", async () => {
    // printf 'syllabus-drive-key-id:%s' new-key | shasum -a 256 | cut -c1-8
    expect(await keyId("new-key")).toBe("c8cc8b7f");
  });

  it("counts, with the runbook's own query, the grants not yet under the new key", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    await grantRow(await encrypt("old-key", "a"));
    await grantRow(await encrypt("new-key", "b"));
    const legacy = (await encrypt("new-key", "c")).split(".").slice(0, 2).join(".");
    await grantRow(legacy);
    const kid = "c8cc8b7f";
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM drive_grants WHERE refresh_token_enc NOT LIKE '%.${kid}'`).first<{ n: number }>();
    expect(row!.n).toBe(2); // the old-key grant and the pre-key-id one
    const swept = await sweepDriveGrants({ DB: env.DB, DRIVE_KEY: "new-key", DRIVE_KEY_PREVIOUS: "old-key" });
    expect(swept.remaining).toBe(0);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM drive_grants WHERE refresh_token_enc NOT LIKE '%.${kid}'`).first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it("strands nothing, and rewrites nothing, if DRIVE_KEY is replaced before DRIVE_KEY_PREVIOUS is set", async () => {
    const original = await encrypt("old-key", "1//tok");
    const id = await grantRow(original);
    await expect(openGrant({ DB: env.DB, DRIVE_KEY: "new-key" }, { account_id: id, refresh_token_enc: original })).rejects.toThrow();
    expect(await sealedOf(id)).toBe(original);
    // Putting the old key back is the whole recovery.
    expect(await openGrant({ DB: env.DB, DRIVE_KEY: "old-key" }, { account_id: id, refresh_token_enc: original })).toBe("1//tok");
  });

  it("rolls back by swapping the two secrets, even after the sweep has resealed everything", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    const id = await grantRow(await encrypt("old-key", "1//tok"));
    await sweepDriveGrants({ DB: env.DB, DRIVE_KEY: "new-key", DRIVE_KEY_PREVIOUS: "old-key" });
    expect(sealedKeyId(await sealedOf(id))).toBe(await keyId("new-key"));

    const back = { DB: env.DB, DRIVE_KEY: "old-key", DRIVE_KEY_PREVIOUS: "new-key" };
    expect(await openGrant(back, { account_id: id, refresh_token_enc: await sealedOf(id) })).toBe("1//tok");
    expect(sealedKeyId(await sealedOf(id))).toBe(await keyId("old-key"));
  });

  it("makes a grant unreadable once the previous key is deleted before the sweep finished", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    const id = await grantRow(await encrypt("old-key", "1//tok"));
    const swept = await sweepDriveGrants({ DB: env.DB, DRIVE_KEY: "new-key" });
    expect(swept).toEqual({ resealed: 0, unreadable: 1, remaining: 1 });
    expect(sealedKeyId(await sealedOf(id))).toBe(await keyId("old-key"));
  });

  it("reseals at most 500 grants per run, so a large table takes several hourly runs", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    const sealed = await encrypt("old-key", "1//tok");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 520; i++) {
      const account = `bulk-${String(i).padStart(4, "0")}`;
      stmts.push(
        env.DB.prepare("INSERT INTO accounts (id, google_sub, email, name, picture, created_at, last_signin_at) VALUES (?, ?, ?, '', '', '2026-01-01', '2026-01-01')")
          .bind(account, "sub-" + account, account + "@example.com"),
        env.DB.prepare("INSERT INTO drive_grants (account_id, refresh_token_enc, scopes, google_email, granted_at) VALUES (?, ?, 'drive.file', '', '2026-01-01')")
          .bind(account, sealed),
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const keys = { DB: env.DB, DRIVE_KEY: "new-key", DRIVE_KEY_PREVIOUS: "old-key" };
    const first = await sweepDriveGrants(keys);
    expect(first.resealed).toBe(500);
    expect(first.remaining).toBe(20);
    const second = await sweepDriveGrants(keys);
    expect(second).toEqual({ resealed: 20, unreadable: 0, remaining: 0 });
  });
});

// --- The proxy's audio meter --------------------------------------------------

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** An .m4a whose header says `claimedSeconds`, padded to `bytes` with whatever follows. */
function m4aClaiming(claimedSeconds: number, bytes: number): Uint8Array {
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, 1000);
  view.setUint32(16, claimedSeconds * 1000);
  const head = new Uint8Array([...box("ftyp", new Uint8Array(8)), ...box("moov", box("mvhd", mvhd))]);
  const out = new Uint8Array(bytes);
  out.set(head);
  return out;
}

describe("the transcription meter (threat model F-01)", () => {
  // The header is written by the caller, so "what the file says" is what the
  // caller says. A 12 MiB upload whose mvhd claims one second is charged one
  // second today, whatever audio it really holds (a low bitrate stream packs
  // hours into 12 MiB). This test states the behavior the fix should give and
  // is marked .fails so the suite stays green until the fix lands; when it
  // does, vitest reports this as a failure and the marker comes off.
  it.fails("does not charge one second for twelve megabytes of audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("the transcript", { status: 200 })));
    const { token } = await claimDevice("meter-liar@example.com");
    const bytes = 12 * 1024 * 1024 - 1024;
    const form = new FormData();
    form.set("audio", new File([m4aClaiming(1, bytes)], "chunk_001.m4a", { type: "audio/mp4" }));
    form.set("duration_seconds", "1");
    const res = await SELF.fetch(ORIGIN + "/proxy/transcribe", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.77" },
      body: form,
    });
    expect(res.status).toBe(200);
    const charged = ((await res.json()) as { audio_seconds: number }).audio_seconds;
    // 192 kbps is the highest bitrate the proxy's own size cap is sized for
    // (MAX_AUDIO_BYTES in proxy.ts), so 12 MiB cannot honestly be under ~500 s
    // of audio at that rate; a lower bitrate only makes it longer.
    expect(charged).toBeGreaterThanOrEqual(500);
  });
});
