/**
 * Browser sessions can be revoked server-side (session_version).
 *
 * The cookie carries the account's session_version; a request whose cookie
 * names an older one is signed out. These tests mint cookies directly with
 * chosen versions (sessionCookieFor), so each one states which version a
 * cookie carries rather than depending on how the callback wrote it.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import { REAUTH_MINUTES } from "../src/account";
import { claimDevice, get, postForm, sessionCookieFor, signedInAs } from "./helpers";

async function bump(accountId: string) {
  await env.DB.prepare("UPDATE accounts SET session_version = session_version + 1 WHERE id = ?").bind(accountId).run();
}
async function version(accountId: string): Promise<number> {
  return (await db.accountById(env.DB, accountId))!.session_version;
}
const signedIn = async (cookie: string) => (await get("/me", { Cookie: cookie })).status === 200;

describe("a cookie whose version is behind the account's", () => {
  it("is signed out on a page, a JSON route and the panel relay", async () => {
    const mine = await claimDevice("sv-classes@example.com");
    const old = mine.cookie; // version 0
    expect(await signedIn(old)).toBe(true);
    expect((await get("/", { Cookie: old })).status).toBe(200);
    expect((await get("/account/delete", { Cookie: old })).status).toBe(200);
    await bump(mine.account.id);

    expect(await signedIn(old)).toBe(false);
    // Page: the landing page, not the account page.
    expect(await (await get("/", { Cookie: old })).text()).not.toContain("sv-classes@example.com");
    // Page that redirects to sign-in.
    const del = await get("/account/delete", { Cookie: old });
    expect(del.status).toBe(302);
    expect(del.headers.get("Location")).toContain("/login");
    // The /p/ relay, page and API.
    const relayPage = await get(`/p/${mine.deviceId}/`, { Cookie: old });
    expect([302, 401]).toContain(relayPage.status);
    expect((await get(`/p/${mine.deviceId}/api/status`, { Cookie: old })).status).toBe(401);
  });

  it("cannot make a state change through the cross-site guard's routes either", async () => {
    const victim = await claimDevice("sv-post@example.com");
    await bump(victim.account.id);
    const before = (await db.accountById(env.DB, victim.account.id))!.token_version;

    const revoke = await postForm("/devices/revoke-all", {}, { Cookie: victim.cookie });
    expect(revoke.status).toBe(302);
    expect(revoke.headers.get("Location")).toContain("/login");
    expect((await db.accountById(env.DB, victim.account.id))!.token_version).toBe(before);

    const del = await postForm("/account/delete", { confirm_email: "sv-post@example.com" }, { Cookie: victim.cookie });
    expect(del.status).toBe(302);
    expect(await db.accountById(env.DB, victim.account.id)).not.toBeNull();
  });
});

describe("a cookie at or ahead of the account's version", () => {
  it("works when the versions match after a bump", async () => {
    const { account } = await signedInAs("sv-match@example.com");
    await bump(account.id);
    const fresh = await sessionCookieFor({ ...account, session_version: 1 });
    expect(await signedIn(fresh)).toBe(true);
  });

  it("is refused when it names a version the account has not reached", async () => {
    const { account } = await signedInAs("sv-future@example.com");
    expect(await signedIn(await sessionCookieFor(account, { v: 5 }))).toBe(false);
  });

  it("is refused when v is not a non-negative integer", async () => {
    const { account } = await signedInAs("sv-junk@example.com");
    for (const v of [-1, 0.5, "0"]) {
      const cookie = await sessionCookieFor(account, { v: v as number });
      expect(await signedIn(cookie), String(v)).toBe(false);
    }
  });
});

describe("a cookie with no version (issued before this change)", () => {
  it("counts as version 0: it works until the account is bumped, then never again", async () => {
    const { account } = await signedInAs("sv-legacy@example.com");
    const legacy = await sessionCookieFor(account, { v: null });
    expect(await signedIn(legacy)).toBe(true);
    await bump(account.id);
    expect(await signedIn(legacy)).toBe(false);
  });
});

describe("Sign out everywhere", () => {
  it("bumps the version, signs out other browsers, and keeps the one that pressed it", async () => {
    const mine = await claimDevice("sv-all@example.com");
    const otherBrowser = await sessionCookieFor(mine.account);
    const stolen = await sessionCookieFor(mine.account);

    const res = await postForm("/devices/revoke-all", {}, { Cookie: mine.cookie });
    expect(res.status).toBe(302);
    expect(await version(mine.account.id)).toBe(1);

    expect(await signedIn(otherBrowser)).toBe(false);
    expect(await signedIn(stolen)).toBe(false);
    expect(await signedIn(mine.cookie)).toBe(false); // the old cookie itself

    // The presser got a replacement under the new version.
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-syllabus_accounts_session="))!;
    expect(setCookie).toBeTruthy();
    const replacement = setCookie.split(";")[0];
    expect(await signedIn(replacement)).toBe(true);
    expect((await get("/", { Cookie: replacement })).status).toBe(200);
  });

  it("is offered under that name, and says it reaches browsers as well as Macs", async () => {
    const mine = await claimDevice("sv-label@example.com");
    const html = await (await get("/", { Cookie: mine.cookie })).text();
    expect(html).toContain("<button>Sign out everywhere</button>");
    expect(html).toContain("signs out every Mac and every other browser signed in to this account");
    expect(html).not.toContain("Sign out every Mac");
  });

  it("does not give the replacement a fresh sign-in time (deleting still needs a recent sign-in)", async () => {
    const { account } = await signedInAs("sv-reauth@example.com");
    const stale = await sessionCookieFor(account, { t: Date.now() - (REAUTH_MINUTES + 5) * 60_000 });
    const res = await postForm("/devices/revoke-all", {}, { Cookie: stale });
    const replacement = res.headers.getSetCookie().find((c) => c.startsWith("__Host-syllabus_accounts_session="))!.split(";")[0];
    const del = await postForm("/account/delete", { confirm_email: "sv-reauth@example.com" }, { Cookie: replacement });
    expect(del.status).toBe(403); // "sign in again", not the deletion
    expect(await db.accountById(env.DB, account.id)).not.toBeNull();
  });

  it("leaves other accounts' sessions alone", async () => {
    const a = await claimDevice("sv-a@example.com");
    const b = await signedInAs("sv-b@example.com");
    await postForm("/devices/revoke-all", {}, { Cookie: a.cookie });
    expect(await version(b.account.id)).toBe(0);
    expect(await signedIn(b.cookie)).toBe(true);
  });

  it("a sign-in after the bump gets the new version and works", async () => {
    const { account } = await signedInAs("sv-again@example.com");
    const res = await postForm("/devices/revoke-all", {}, { Cookie: await sessionCookieFor(account) });
    expect(res.status).toBe(302);
    // upsertAccount is what the callback calls; setSession stamps its version.
    const reloaded = await db.upsertAccount(env.DB, { sub: "sub-sv-again@example.com", email: "sv-again@example.com", name: "", picture: "" });
    expect(reloaded.session_version).toBe(1);
    expect(await signedIn(await sessionCookieFor(reloaded))).toBe(true);
  });

  it("two presses at once hand out different versions, and only the last one's cookie survives", async () => {
    const { account } = await signedInAs("sv-race@example.com");
    const [r1, r2] = await Promise.all([db.revokeEverything(env.DB, account.id), db.revokeEverything(env.DB, account.id)]);
    expect(new Set([r1.sessionVersion, r2.sessionVersion])).toEqual(new Set([1, 2]));
    const okay = [r1, r2].filter((r) => r.sessionVersion === 2)[0]!;
    expect(await signedIn(await sessionCookieFor({ ...account, session_version: okay.sessionVersion }))).toBe(true);
    expect(await signedIn(await sessionCookieFor({ ...account, session_version: 1 }))).toBe(false);
  });

  it("a login that read the old version cannot leave a valid old-version cookie after the bump", async () => {
    // The callback reads the account, then signs a cookie carrying what it read.
    // If a bump lands between the two, that cookie is behind the account.
    const { account } = await signedInAs("sv-login-race@example.com");
    const readBeforeBump = await db.accountById(env.DB, account.id);
    await db.revokeEverything(env.DB, account.id);
    const cookieFromTheRace = await sessionCookieFor(readBeforeBump!);
    expect(await signedIn(cookieFromTheRace)).toBe(false);
  });
});

describe("other ways a session ends", () => {
  it("plain sign-out only clears this browser's cookie", async () => {
    const { account, cookie } = await signedInAs("sv-logout@example.com");
    const other = await sessionCookieFor(account);
    const res = await postForm("/logout", {}, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await version(account.id)).toBe(0);
    expect(await signedIn(other)).toBe(true);
  });

  it("deleting the account ends the cookie because the account row is gone, and it does not come back for a new account", async () => {
    const { account } = await signedInAs("sv-delete@example.com");
    const cookie = await sessionCookieFor(account);
    await db.deleteAccountData(env.DB, account.id, "hash");
    expect(await signedIn(cookie)).toBe(false);
    const reborn = await db.upsertAccount(env.DB, { sub: "sub-sv-delete@example.com", email: "sv-delete@example.com", name: "", picture: "" });
    expect(reborn.id).not.toBe(account.id);
    expect(await signedIn(cookie)).toBe(false);
  });
});
