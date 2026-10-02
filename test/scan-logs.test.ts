import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs ops script, no types
import { events, report, scan } from "../scripts/scan-logs.mjs";

/** One event the way `wrangler tail --format json` writes it. */
function event(logs: string[], url = "https://accounts.test/me", exceptions: { name: string; message: string }[] = []) {
  return JSON.stringify(
    { outcome: "ok", event: { request: { url, method: "GET" } }, logs: logs.map((message) => ({ message: [message], level: "log" })), exceptions },
    null,
    2,
  );
}

describe("scanning a production log capture", () => {
  it("reads events written back to back, including braces inside strings", () => {
    const text = event(["drive keys: resealed 0 {not json}"]) + "\n" + event(["second"]);
    expect(events(text)).toHaveLength(2);
  });

  it("passes the lines this service writes, and ignores the URL Cloudflare records", () => {
    const text = event(
      ["proxy: provider measured 480s of audio against 3s reserved", "stripe: trial spent, ended sub_123 for acct_ABC"],
      "https://accounts.test/oauth2/callback?code=4/0AbCdEf&state=xyz",
    );
    const result = scan(text);
    expect(result).toMatchObject({ events: 1, lines: 2, findings: [] });
    expect(report(result)).toContain("No personal data or secrets found");
  });

  it("finds each kind of leak in a log line or an exception, and never repeats the value", () => {
    const text = [
      event(["signed in as student@university.edu"]),
      event(["calling with Bearer syd_abcdefghijklmnop"]),
      event(["key sk_live_51Habcdefghijkl"]),
      event([], "https://accounts.test/", [{ name: "Error", message: "token endpoint said ya29.a0AfH6SMBxyz" }]),
      event(["redirect to /p/d1/_auth?t=abcdef123456"]),
    ].join("\n");
    const result = scan(text);
    const kinds = result.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["email", "bearer token", "device token", "Stripe key", "Google token", "query string"]));
    const said = report(result);
    for (const secret of ["student@university.edu", "syd_abcdefghijklmnop", "sk_live_51H", "ya29.", "abcdef123456"]) {
      expect(said).not.toContain(secret);
    }
  });

  it("says when a capture logged nothing, rather than calling it clean", () => {
    expect(report(scan(event([])))).toContain("proves little");
  });
});
