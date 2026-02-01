import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SkillService } from "./skill.service";
import { webSearch } from "./web-search.service";

export type ToolName =
  | "time_now"
  | "fetch_url"
  | "web_search"
  | "fs_list"
  | "fs_read"
  | "fs_search"
  | "skill_list"
  | "skill_read";

export type ToolCall = { name: ToolName | string; arguments?: any };

export type ToolsConfig = {
  enabled?: string[];
  fsRoots?: string[];
  maxReadBytes?: number;
};

export type WebSearchConfig = {
  enabled?: boolean;
  tavilyApiKey?: string;
  maxResults?: number;
};

export type SkillsConfig = {
  dir?: string;
};

export type ToolRuntimeConfig = {
  tools?: ToolsConfig;
  webSearch?: WebSearchConfig;
  skills?: SkillsConfig;
};

export type ToolResult = {
  ok: boolean;
  name: string;
  content: string;
};

function safeString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function clampInt(n: unknown, min: number, max: number, fallback: number) {
  const x = Math.floor(Number(n) || 0);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function normalizeEnabled(list: unknown): Set<string> {
  if (!Array.isArray(list)) return new Set();
  return new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean));
}

function normalizeRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const out: string[] = [];
  for (const r of roots) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    try {
      const p = resolve(s);
      if (!existsSync(p)) continue;
      if (!statSync(p).isDirectory()) continue;
      out.push(p);
    } catch {}
  }
  return Array.from(new Set(out));
}

function isPathInside(child: string, parent: string) {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  const rel = c.slice(p.length);
  return rel.startsWith("\\") || rel.startsWith("/");
}

function pickFirstRootedPath(roots: string[], p: string): string | null {
  const raw = String(p ?? "").trim();
  if (!raw) return null;

  // Allow absolute only if inside a root; otherwise treat as relative to root[0].
  const abs = resolve(raw);
  for (const r of roots) {
    if (isPathInside(abs, r)) return abs;
  }

  if (!roots.length) return null;
  const joined = resolve(roots[0], raw);
  if (!isPathInside(joined, roots[0])) return null;
  return joined;
}

function readTextWithLimit(p: string, maxBytes: number) {
  const buf = readFileSync(p);
  const sliced = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  let text = "";
  try {
    text = sliced.toString("utf-8");
  } catch {
    text = String(sliced);
  }
  if (buf.byteLength > maxBytes) text += `\n\n[... truncated to ${maxBytes} bytes ...]`;
  return text;
}

function listFilesRecursive(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const q: string[] = [root];
  while (q.length && out.length < maxFiles) {
    const dir = q.shift()!;
    let entries: any[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as any[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        q.push(p);
        continue;
      }
      if (e.isFile()) out.push(p);
    }
  }
  return out;
}

function matchSimpleGlob(path: string, glob: string) {
  // Very small subset: "*.ext" or "**/*.ext" or raw substring.
  const g = String(glob ?? "").trim();
  if (!g || g === "**/*") return true;
  if (g.startsWith("**/*.")) {
    const ext = g.slice("**/*.".length);
    return path.toLowerCase().endsWith("." + ext.toLowerCase());
  }
  if (g.startsWith("*.")) {
    const ext = g.slice("*.".length);
    return path.toLowerCase().endsWith("." + ext.toLowerCase());
  }
  return path.toLowerCase().includes(g.toLowerCase());
}

export const ALL_TOOLS: { name: ToolName; title: string; description: string; args: string }[] = [
  {
    name: "time_now",
    title: "Get current time",
    description: "Return current local time as ISO string.",
    args: "{}"
  },
  {
    name: "web_search",
    title: "Web search (Tavily)",
    description: "Search the web for a query. Requires Web Search enabled + Tavily API Key.",
    args: "{\"query\": string, \"maxResults\"?: number}"
  },
  {
    name: "fetch_url",
    title: "Fetch URL",
    description: "HTTP GET a URL and return a truncated text body (best-effort).",
    args: "{\"url\": string, \"maxBytes\"?: number}"
  },
  {
    name: "fs_list",
    title: "List files",
    description: "List files under configured fsRoots (recursive) with optional simple glob filter.",
    args: "{\"root\"?: string, \"glob\"?: string, \"maxFiles\"?: number}"
  },
  {
    name: "fs_read",
    title: "Read file",
    description: "Read a text file under configured fsRoots. Truncates large files.",
    args: "{\"path\": string, \"maxBytes\"?: number}"
  },
  {
    name: "fs_search",
    title: "Search in files",
    description: "Search a literal string in files under fsRoots (simple scan).",
    args: "{\"query\": string, \"glob\"?: string, \"maxFiles\"?: number, \"maxMatches\"?: number}"
  },
  {
    name: "skill_list",
    title: "List skills",
    description: "List skills found in skills dir (~/.claude/skills by default).",
    args: "{}"
  },
  {
    name: "skill_read",
    title: "Read skill",
    description: "Read SKILL.md for a given skill name.",
    args: "{\"name\": string}"
  }
];

export function renderToolDocs(allowed: Set<string>) {
  const lines: string[] = [];
  for (const t of ALL_TOOLS) {
    if (!allowed.has(t.name)) continue;
    lines.push(`- ${t.name}: ${t.description}`);
    lines.push(`  args: ${t.args}`);
  }
  return lines.join("\n");
}

export class ToolService {
  #cfg: ToolRuntimeConfig;
  #skills: SkillService;

  constructor(cfg: ToolRuntimeConfig) {
    this.#cfg = cfg || {};
    this.#skills = new SkillService({ skillsDir: safeString(cfg?.skills?.dir).trim() || undefined });
  }

  get availableToolNames(): ToolName[] {
    return ALL_TOOLS.map((t) => t.name);
  }

  get skillService() {
    return this.#skills;
  }

  getAllowedTools(overrides?: { allowlist?: string[] }) {
    const enabledCfg = normalizeEnabled(this.#cfg?.tools?.enabled);
    const allowlist = overrides?.allowlist ? normalizeEnabled(overrides.allowlist) : null;

    const out = new Set<string>();
    for (const t of ALL_TOOLS) {
      const isEnabled = enabledCfg.has(t.name);
      if (!isEnabled) continue;
      if (allowlist && !allowlist.has(t.name)) continue;
      out.add(t.name);
    }

    // web_search is additionally gated by webSearch.enabled (UI toggle)
    if (!this.#cfg?.webSearch?.enabled) out.delete("web_search");
    return out;
  }

  async run(call: ToolCall): Promise<ToolResult> {
    const name = String(call?.name ?? "").trim();
    const args = (call as any)?.arguments ?? {};

    const enabled = normalizeEnabled(this.#cfg?.tools?.enabled);
    if (!enabled.has(name) && name !== "web_search") {
      return { ok: false, name, content: `Tool not enabled: ${name}` };
    }

    try {
      if (name === "time_now") {
        return { ok: true, name, content: new Date().toISOString() };
      }

      if (name === "web_search") {
        if (!this.#cfg?.webSearch?.enabled) return { ok: false, name, content: "Web search disabled." };
        const apiKey = safeString(this.#cfg?.webSearch?.tavilyApiKey || process.env.TAVILY_API_KEY).trim();
        if (!apiKey) return { ok: false, name, content: "Missing Tavily API key." };
        const q = safeString(args?.query).trim();
        if (!q) return { ok: false, name, content: "Missing query." };
        const maxResults = clampInt(args?.maxResults ?? this.#cfg?.webSearch?.maxResults ?? 6, 1, 10, 6);
        const results = await webSearch(q, { apiKey, maxResults, timeoutMs: 12_000 });
        if (!results.length) return { ok: true, name, content: "(no results)" };
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ""}`.trim());
        return { ok: true, name, content: lines.join("\n\n") };
      }

      if (name === "fetch_url") {
        const url = safeString(args?.url).trim();
        if (!url) return { ok: false, name, content: "Missing url." };
        const maxBytes = clampInt(args?.maxBytes ?? 40_000, 2_000, 200_000, 40_000);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        try {
          const res = await fetch(url, { method: "GET", signal: ctrl.signal });
          const ct = safeString(res.headers.get("content-type"));
          const buf = new Uint8Array(await res.arrayBuffer());
          const sliced = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
          let text = "";
          try {
            text = Buffer.from(sliced).toString("utf-8");
          } catch {
            text = String(sliced);
          }
          if (buf.byteLength > maxBytes) text += `\n\n[... truncated to ${maxBytes} bytes ...]`;
          return { ok: true, name, content: `status=${res.status}\ncontent-type=${ct}\n\n${text}`.trim() };
        } finally {
          clearTimeout(t);
        }
      }

      const roots = normalizeRoots(this.#cfg?.tools?.fsRoots);
      const maxReadBytes = clampInt(this.#cfg?.tools?.maxReadBytes ?? 80_000, 5_000, 500_000, 80_000);

      if (name === "fs_list") {
        if (!roots.length) return { ok: false, name, content: "No fsRoots configured." };
        const root = safeString(args?.root).trim();
        const glob = safeString(args?.glob).trim() || "**/*";
        const maxFiles = clampInt(args?.maxFiles ?? 500, 1, 5000, 500);
        const base = root ? pickFirstRootedPath(roots, root) : roots[0];
        if (!base) return { ok: false, name, content: "Invalid root." };
        const files = listFilesRecursive(base, maxFiles).filter((p) => matchSimpleGlob(p, glob));
        const rel = (p: string) => {
          for (const r of roots) {
            if (isPathInside(p, r)) return p.slice(r.length).replace(/^\\+/, "").replace(/^\//, "") || ".";
          }
          return p;
        };
        return { ok: true, name, content: files.map(rel).join("\n") || "(empty)" };
      }

      if (name === "fs_read") {
        if (!roots.length) return { ok: false, name, content: "No fsRoots configured." };
        const p = safeString(args?.path).trim();
        if (!p) return { ok: false, name, content: "Missing path." };
        const maxBytes = clampInt(args?.maxBytes ?? maxReadBytes, 1000, 500_000, maxReadBytes);
        const resolved = pickFirstRootedPath(roots, p);
        if (!resolved) return { ok: false, name, content: "Path is outside fsRoots." };
        if (!existsSync(resolved)) return { ok: false, name, content: "File not found." };
        if (!statSync(resolved).isFile()) return { ok: false, name, content: "Not a file." };
        return { ok: true, name, content: readTextWithLimit(resolved, maxBytes) };
      }

      if (name === "fs_search") {
        if (!roots.length) return { ok: false, name, content: "No fsRoots configured." };
        const q = safeString(args?.query).trim();
        if (!q) return { ok: false, name, content: "Missing query." };
        const glob = safeString(args?.glob).trim() || "**/*";
        const maxFiles = clampInt(args?.maxFiles ?? 400, 1, 5000, 400);
        const maxMatches = clampInt(args?.maxMatches ?? 80, 1, 500, 80);
        const files = listFilesRecursive(roots[0], maxFiles).filter((p) => matchSimpleGlob(p, glob));
        const matches: string[] = [];
        for (const p of files) {
          if (matches.length >= maxMatches) break;
          let text = "";
          try {
            text = readTextWithLimit(p, Math.min(200_000, maxReadBytes));
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxMatches) break;
            if (lines[i].includes(q)) {
              const rel = p.slice(roots[0].length).replace(/^\\+/, "").replace(/^\//, "") || ".";
              matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 280)}`.trim());
            }
          }
        }
        return { ok: true, name, content: matches.join("\n") || "(no matches)" };
      }

      if (name === "skill_list") {
        const skills = this.#skills.listSkills().map((s) => s.name);
        return { ok: true, name, content: skills.join("\n") || "(empty)" };
      }

      if (name === "skill_read") {
        const skillName = safeString(args?.name).trim();
        if (!skillName) return { ok: false, name, content: "Missing name." };
        const md = this.#skills.readSkillMarkdown(skillName);
        if (!md.trim()) return { ok: false, name, content: `Skill not found or empty: ${skillName}` };
        return { ok: true, name, content: md.trim() };
      }

      return { ok: false, name, content: `Unknown tool: ${name}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, name, content: `Tool error: ${msg}` };
    }
  }
}

