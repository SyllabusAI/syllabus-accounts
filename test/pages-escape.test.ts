import { describe, expect, it } from "vitest";
import { panelNotConnectedPage } from "../src/pages";

describe("panelNotConnectedPage", () => {
  it("escapes the Mac's name once", () => {
    const html = panelNotConnectedPage("R&D <Mac>", "", false);
    expect(html).toContain("<h1>R&amp;D &lt;Mac&gt; is not connected</h1>");
    expect(html).not.toContain("&amp;amp;");
  });
});
