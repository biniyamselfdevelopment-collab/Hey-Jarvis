import { z } from "zod";
import type { JarvisConfig } from "../config.js";
import { defineTool } from "./types.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = "Mozilla/5.0 (compatible; HeyJarvis/0.1; +https://github.com/biniyamselfdevelopment-collab/Hey-Jarvis)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Parse DuckDuckGo's no-JS results page (html.duckduckgo.com). No API key needed. */
export function parseDuckDuckGo(html: string, limit = 6): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/class="result__body"|class="result results_links/).slice(1);
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link?.[1] || !link[2]) continue;
    let url = decodeEntities(link[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect?.[1]) url = decodeURIComponent(redirect[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (url.includes("duckduckgo.com/y.js")) continue; // ads
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? "";
    results.push({ title: stripTags(link[2]), url, snippet: stripTags(snippet) });
    if (results.length >= limit) break;
  }
  return results;
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }),
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text());
}

async function searchBrave(query: string, apiKey: string, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?count=6&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "x-subscription-token": apiKey, accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? "") }));
}

/** Turn an HTML page into readable plain text for the model. */
export function htmlToText(html: string, maxChars = 8000): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<(head|script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const full = title ? `${stripTags(title)}\n\n${text}` : text;
  return full.length > maxChars ? full.slice(0, maxChars) + "\n…[truncated]" : full;
}

export function webTools(config: JarvisConfig) {
  const webSearch = defineTool({
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets. Follow up with fetch_page to read a result.",
    risk: "low",
    input: z.object({ query: z.string().min(1) }),
    describe: ({ query }) => `Search the web for "${query}".`,
    async run({ query }, { signal }) {
      const key = config.search.apiKeyEnv ? process.env[config.search.apiKeyEnv] : undefined;
      if (config.search.provider === "brave" && key) return searchBrave(query, key, signal);
      return searchDuckDuckGo(query, signal);
    },
  });

  const fetchPage = defineTool({
    name: "fetch_page",
    description: "Download a web page and return its readable text.",
    risk: "low",
    input: z.object({ url: z.string().url() }),
    describe: ({ url }) => `Read ${new URL(url).hostname}.`,
    async run({ url }, { signal }) {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      return type.includes("html") ? htmlToText(body) : body.slice(0, 8000);
    },
  });

  return [webSearch, fetchPage];
}
