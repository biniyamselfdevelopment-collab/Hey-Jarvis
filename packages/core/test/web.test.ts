import { describe, expect, it } from "vitest";
import { htmlToText, parseDuckDuckGo } from "../src/tools/web.js";

const DDG = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftauri.app%2F&amp;rut=abc">Tauri &amp; <b>Rust</b></a></h2>
    <a class="result__snippet" href="x">Build <b>smaller</b>, faster apps.</a>
  </div>
</div>
<div class="result results_links results_links_deep result--ad">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/page">Example</a></h2>
    <a class="result__snippet" href="y">It&#39;s an example.</a>
  </div>
</div>`;

describe("parseDuckDuckGo", () => {
  it("extracts results, unwraps redirects and skips ads", () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: "Tauri & Rust", url: "https://tauri.app/", snippet: "Build smaller, faster apps." },
      { title: "Example", url: "https://example.com/page", snippet: "It's an example." },
    ]);
  });
  it("respects the limit", () => {
    expect(parseDuckDuckGo(DDG, 1)).toHaveLength(1);
  });
});

describe("htmlToText", () => {
  it("keeps the title and paragraphs and drops scripts/nav", () => {
    const html = `<html><head><title>News</title><script>evil()</script></head>
      <body><nav>Menu</nav><h1>Headline</h1><p>First &amp; foremost.</p><p>Second.</p></body></html>`;
    expect(htmlToText(html)).toBe("News\n\nHeadline\nFirst & foremost.\nSecond.");
  });
  it("truncates long pages", () => {
    expect(htmlToText("<p>" + "a".repeat(100) + "</p>", 10)).toBe("aaaaaaaaaa\n…[truncated]");
  });
});
