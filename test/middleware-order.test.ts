import { describe, expect, it } from "vitest";
import { get, postForm, rateLimitWindows, signedInAs } from "./helpers";

// src/index.ts registers crossSiteGuard (PR #48) and the per-account request
// floor (PR #47) with app.use. The guard has to come first: a request it
// refuses must not spend the signed-in person's request budget, or any page on
// the internet could use a visitor's browser to burn the budget of the account
// they are signed in to.
describe("middleware order", () => {
  it("does not count a refused cross-site post against the account's request floor", async () => {
    const a = await signedInAs("order-a@example.com");
    for (let i = 0; i < 5; i++) {
      const res = await postForm("/logout", {}, { Cookie: a.cookie, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
      expect(res.status).toBe(403);
    }
    expect(await rateLimitWindows(`session-req:${a.account.id}`)).toEqual([]);
    // The same person's own same-origin request is counted, so the empty result above is not a dead counter.
    expect((await get("/me", { Cookie: a.cookie })).status).toBe(200);
    expect((await rateLimitWindows(`session-req:${a.account.id}`)).length).toBe(1);
  });
});
