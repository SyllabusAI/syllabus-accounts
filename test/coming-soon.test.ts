import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, postForm, signedInAs } from "./helpers";

// SALES_OPEN off: plans show "coming soon" and nothing can be bought.
describe("sales closed", () => {
  const e = env as { SALES_OPEN?: string };
  let saved: string | undefined;
  beforeEach(() => {
    saved = e.SALES_OPEN;
    e.SALES_OPEN = "false";
  });
  afterEach(() => {
    e.SALES_OPEN = saved;
    vi.unstubAllGlobals();
  });

  it("shows coming soon instead of the plan buttons and the code form", async () => {
    const { cookie } = await signedInAs("soon@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Paid plans are coming soon.");
    expect(html).not.toContain('action="/billing/checkout"');
    expect(html).not.toContain("Redeem a code");
  });

  it("refuses checkout and upgrade without calling Stripe", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const { cookie } = await signedInAs("soon2@example.com");
    const checkout = await (await postForm("/billing/checkout", { tier: "starter" }, { Cookie: cookie })).text();
    expect(checkout).toContain("Plans are coming soon");
    const coded = await (await postForm("/billing/checkout", { tier: "pro", redeem: "1" }, { Cookie: cookie })).text();
    expect(coded).toContain("Plans are coming soon");
    const upgrade = await (await postForm("/billing/upgrade", { tier: "pro" }, { Cookie: cookie })).text();
    expect(upgrade).toContain("Upgrades are coming soon");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is closed for anything but the exact string true", async () => {
    e.SALES_OPEN = undefined;
    const { cookie } = await signedInAs("soon3@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Paid plans are coming soon.");
  });
});
