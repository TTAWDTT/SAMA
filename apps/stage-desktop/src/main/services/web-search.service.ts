export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function safeString(v: unknown) {
  return typeof v === "string" ? v : "";
}

/**
 * Web search via Tavily (https://tavily.com/).
 * Configure with `TAVILY_API_KEY` env var (or pass `apiKey` explicitly).
 */
export async function webSearch(
  query: string,
  opts?: { apiKey?: string; maxResults?: number; timeoutMs?: number }
): Promise<WebSearchResult[]> {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const apiKey = safeString(opts?.apiKey ?? process.env.TAVILY_API_KEY).trim();
  if (!apiKey) {
    throw new Error("missing TAVILY_API_KEY");
  }

  const maxResults = Math.max(1, Math.min(10, Math.floor(Number(opts?.maxResults ?? 6))));
  const timeoutMs = Math.max(2000, Math.min(45_000, Math.floor(Number(opts?.timeoutMs ?? 12_000))));

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data: any = await res.json();
    const items: any[] = Array.isArray(data?.results) ? data.results : [];
    return items
      .map((r: any) => ({
        title: safeString(r?.title).trim(),
        url: safeString(r?.url).trim(),
        snippet: safeString(r?.content).trim()
      }))
      .filter((r) => r.title && r.url)
      .slice(0, maxResults);
  } finally {
    clearTimeout(t);
  }
}
