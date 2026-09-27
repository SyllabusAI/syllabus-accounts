/**
 * Attempts to get around the security bar, each one expected to fail.
 *
 * security.test.ts shows each guard doing its job for an honest caller and an
 * obvious abuser. These are the less obvious abusers: the ones who vary what
 * the guard keys on, spell a route differently, forge a header, or hand the
 * Drive-key code a sealed value it did not write.
 */

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, keyId, sealedKeyId } from "../src/crypto";
import { unseal } from "../src/drive-keys";
import { ipv6Bucket, LIMITS, type Limit } from "../src/limits";
import { get, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

async function fill(bucket: string, rule: Limit) {
  const start = Math.floor(Date.now() / 1000 / rule.window) * rule.window;
  for (const w of [start, start + rule.window]) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET count = excluded.count",
    )
      .bind(bucket, w, rule.limit)
      .run();
  }
}

describe("an IPv6 client cannot step around a per-address limit", () => {
  it("keys every address in one /64, however it is spelled, the same", () => {
    const key = "2001:db8:0:1::/64";
    for (const spelling of [
      "2001:db8:0:1::1",
      "2001:0db8:0000:0001:0000:0000:0000:0002",
      "2001:DB8:0:1:ffff:ffff:ffff:ffff",
      "2001:db8::1:dead:beef:0:1",
      "2001:db8:0:1::1%eth0",
      "2001:db8:0:1:0:0:192.0.2.1",
    ]) {
      expect(ipv6Bucket(spelling), spelling).toBe(key);
    }
    expect(ipv6Bucket("2001:db8:0:2::1")).toBe("2001:db8:0:2::/64");
    expect(ipv6Bucket("::1")).toBe("0:0:0:0::/64");
  });

  it("reads an IPv4-mapped address as the IPv4 address it is", () => {
    expect(ipv6Bucket("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(ipv6Bucket("::FFFF:192.0.2.7")).toBe("192.0.2.7");
  });

  it("returns what it cannot parse unchanged rather than lumping it anywhere", () => {
    for (const odd of ["1::2::3", "2001:db8:0:1:2:3:4:5:6", "zzzz::1", "::ffff:300.1.1.1", "203.0.113.5:12"]) {
      expect(ipv6Bucket(odd)).toBe(odd);
    }
  });

  it("refuses /login to a fresh address in a /64 that is over its limit", async () => {
    await fill("login:2001:db8:aa:1::/64", LIMITS.login);
    const res = await get("/login", { "CF-Connecting-IP": "2001:db8:aa:1:9f3c:12:7:" + (Date.now() % 65536).toString(16) });
    expect(res.status).toBe(429);
    // The neighboring /64 is somebody else.
    expect((await get("/login", { "CF-Connecting-IP": "2001:db8:aa:2::1" })).status).toBe(302);
  });

  it("stops one /64 from allocating device claims by rotating addresses", async () => {
    await fill("device-start:2001:db8:bb:1::/64", LIMITS.deviceStart);
    const res = await postJson("/device/start", { name: "Rotating" }, { "CF-Connecting-IP": "2001:db8:bb:1:1234:5678:9abc:def0" });
    expect(res.status).toBe(429);
  });
});

describe("the client address comes from the edge and nowhere else", () => {
  it("ignores X-Forwarded-For and X-Real-IP", async () => {
    const ip = "198.51.100.70";
    await fill(`login:${ip}`, LIMITS.login);
    const res = await get("/login", { "CF-Connecting-IP": ip, "X-Forwarded-For": "192.0.2.99", "X-Real-IP": "192.0.2.98" });
    expect(res.status).toBe(429);
  });

  it("does not let X-Forwarded-For pick a bucket when the edge header is missing", async () => {
    await fill("login:unknown", LIMITS.login);
    try {
      const res = await SELF.fetch(ORIGIN + "/login", { headers: { "X-Forwarded-For": "192.0.2.97" }, redirect: "manual" });
      expect(res.status).toBe(429);
    } finally {
      await env.DB.prepare("DELETE FROM rate_limits WHERE bucket = 'login:unknown'").run();
    }
  });
});

describe("a limited route cannot be reached by another spelling of it", () => {
  it("does not route a case or trailing-slash variant to the handler", async () => {
    for (const path of ["/LOGIN", "/Login", "/login/", "/oauth2/callback/", "/OAUTH2/CALLBACK"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    for (const path of ["/device/start/", "/DEVICE/START", "/device/poll/"]) {
      expect((await postJson(path, {})).status, path).toBe(404);
    }
  });

  it("counts a HEAD /login against the same limit as a GET", async () => {
    const ip = "198.51.100.71";
    await fill(`login:${ip}`, LIMITS.login);
    const res = await SELF.fetch(ORIGIN + "/login", { method: "HEAD", headers: { "CF-Connecting-IP": ip }, redirect: "manual" });
    expect(res.status).toBe(429);
  });
});

describe("looking up device codes from many accounts on one address", () => {
  it("is limited per address, not only per account", async () => {
    const ip = "198.51.100.72";
    await fill(`device-lookup-ip:${ip}`, LIMITS.deviceLookupAddress);
    const fresh = await signedInAs(`lookup-${Date.now()}@example.com`);
    expect((await get("/device?code=ABCD-EFGH", { Cookie: fresh.cookie, "CF-Connecting-IP": ip })).status).toBe(429);
    expect((await get("/device?code=ABCD-EFGH", { Cookie: fresh.cookie, "CF-Connecting-IP": "198.51.100.73" })).status).toBe(200);
  });
});

describe("a form cannot be posted from anywhere but this origin", () => {
  const post = (headers: Record<string, string>, cookie: string) =>
    SELF.fetch(ORIGIN + "/devices/revoke-all", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...headers },
      body: "",
      redirect: "manual",
    });

  it("refuses look-alike origins, a null origin, and a missing one", async () => {
    const { cookie } = await signedInAs("csrf-target@example.com");
    for (const headers of [
      { Origin: "null" },
      { Origin: "https://accounts.test.evil.test" },
      { Origin: "https://evil.test" },
      { Origin: "http://accounts.test" },
      { Origin: "https://accounts.test/" },
      { Origin: "https://sub.accounts.test" },
      { Referer: "https://accounts.test.evil.test/" },
      { Referer: "https://accounts.testevil.test/" },
      { Referer: "https://accounts.test" },
      { Origin: "https://evil.test", Referer: ORIGIN + "/" },
      {},
    ] as Record<string, string>[]) {
      expect((await post(headers, cookie)).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post({ Origin: ORIGIN }, cookie)).status).toBe(302);
    expect((await post({ Referer: ORIGIN + "/" }, cookie)).status).toBe(302);
  });

  it("refuses the sign-out form from another site", async () => {
    const { cookie } = await signedInAs("csrf-logout@example.com");
    const res = await postForm("/logout", {}, { Cookie: cookie, Origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("syllabus_accounts_session=;");
    const sameSite = await get("/logout", { Cookie: cookie, "Sec-Fetch-Site": "same-site" });
    expect(sameSite.headers.get("Set-Cookie")).toBeNull();
  });

  it("leaves the Stripe webhook to its signature, whatever Origin says", async () => {
    for (const Origin of [ORIGIN, "https://evil.test"]) {
      const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00", Origin, "CF-Connecting-IP": "198.51.100.74" },
        body: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", data: { object: {} } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_signature" });
    }
  });
});

describe("a sealed Drive grant cannot be bent by editing its key id", () => {
  const keys = { DRIVE_KEY: "new-key", DRIVE_KEY_PREVIOUS: "old-key" };

  it("treats the key id as a hint: a wrong or unknown one still has to pass GCM", async () => {
    const sealed = await encrypt("old-key", "1//tok");
    const [iv, box] = sealed.split(".");
    // Relabeled as some key nobody has: both keys are tried, the right one opens it.
    expect(await unseal(keys, `${iv}.${box}.00000000`)).toEqual({ plain: "1//tok", stale: true });
    // Relabeled as the current key: only the current key is tried, and it fails.
    await expect(unseal(keys, `${iv}.${box}.${await keyId("new-key")}`)).rejects.toThrow();
  });

  it("refuses a box whose ciphertext or IV was changed", async () => {
    const sealed = await encrypt("new-key", "1//tok");
    const [iv, box, kid] = sealed.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    await expect(unseal(keys, `${iv}.${flip(box)}.${kid}`)).rejects.toThrow();
    await expect(unseal(keys, `${flip(iv)}.${box}.${kid}`)).rejects.toThrow();
    await expect(unseal(keys, `${iv}..${kid}`)).rejects.toThrow();
    await expect(unseal(keys, "")).rejects.toThrow();
  });

  it("never reuses an IV and never leaves the key id out", async () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const sealed = await encrypt("new-key", "same text");
      ivs.add(sealed.split(".")[0]);
      expect(sealedKeyId(sealed)).toBe(await keyId("new-key"));
      expect(await decrypt("new-key", sealed)).toBe("same text");
    }
    expect(ivs.size).toBe(50);
  });

  it("does not make the key id from the same hash the AES key is made from", async () => {
    const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("new-key")));
    const rawHex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(rawHex.startsWith(await keyId("new-key"))).toBe(false);
  });
});
