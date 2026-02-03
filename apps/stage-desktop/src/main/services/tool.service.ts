import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import type { SkillsConfig, ToolsConfig, WebSearchConfig } from "../protocol/types";
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
  | "skill_read"
  | "shell_exec"
  | "code_search"
  | "code_edit"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "memory_store"
  | "memory_query";

export type ToolCall = { name: ToolName | string; arguments?: any };

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
  },
  {
    name: "shell_exec",
    title: "Execute shell command",
    description: "Execute a shell command with safety restrictions. Dangerous commands are blocked.",
    args: "{\"command\": string, \"cwd\"?: string, \"timeout\"?: number}"
  },
  {
    name: "code_search",
    title: "Code pattern search",
    description: "Search code using regex pattern with context lines.",
    args: "{\"pattern\": string, \"glob\"?: string, \"maxResults\"?: number, \"contextLines\"?: number}"
  },
  {
    name: "code_edit",
    title: "Edit code file",
    description: "Apply search/replace edits to a code file.",
    args: "{\"path\": string, \"edits\": [{\"search\": string, \"replace\": string}]}"
  },
  {
    name: "git_status",
    title: "Git status",
    description: "Get git repository status.",
    args: "{\"cwd\"?: string}"
  },
  {
    name: "git_diff",
    title: "Git diff",
    description: "Get git diff output.",
    args: "{\"staged\"?: boolean, \"commit\"?: string, \"path\"?: string, \"cwd\"?: string}"
  },
  {
    name: "git_log",
    title: "Git log",
    description: "Get git commit history.",
    args: "{\"maxCount\"?: number, \"oneline\"?: boolean, \"cwd\"?: string}"
  },
  {
    name: "memory_store",
    title: "Store memory",
    description: "Store a piece of information in long-term memory.",
    args: "{\"key\": string, \"content\": string, \"tags\"?: string[]}"
  },
  {
    name: "memory_query",
    title: "Query memory",
    description: "Query long-term memory by key, tags, or semantic search.",
    args: "{\"query\"?: string, \"key\"?: string, \"tags\"?: string[], \"maxResults\"?: number}"
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

      // ========== New Tools ==========

      if (name === "shell_exec") {
        const command = safeString(args?.command).trim();
        if (!command) return { ok: false, name, content: "Missing command." };

        // Safety: block dangerous commands
        const dangerous = [
          /\brm\s+(-rf?|--force)\s+[\/~]/i,
          /\brmdir\s+\/s/i,
          /\bdel\s+\/[fqs]/i,
          /\bformat\s+/i,
          /\bmkfs\b/i,
          /\bdd\s+if=/i,
          />\s*\/dev\/(sd|hd|nvme)/i,
          /\bshutdown\b/i,
          /\breboot\b/i,
          /\binit\s+[06]/i,
          /:(){ :|:& };:/  // fork bomb
        ];
        for (const pattern of dangerous) {
          if (pattern.test(command)) {
            return { ok: false, name, content: `Dangerous command blocked: ${command.slice(0, 50)}...` };
          }
        }

        const cwd = safeString(args?.cwd).trim() || (roots.length ? roots[0] : process.cwd());
        const timeout = clampInt(args?.timeout ?? 30000, 1000, 120000, 30000);

        try {
          const output = execSync(command, {
            cwd,
            timeout,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
            shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh"
          });
          return { ok: true, name, content: String(output).slice(0, 50000) };
        } catch (err: any) {
          const stderr = err?.stderr ? String(err.stderr).slice(0, 5000) : "";
          const stdout = err?.stdout ? String(err.stdout).slice(0, 5000) : "";
          const msg = err?.message || String(err);
          return { ok: false, name, content: `Command failed: ${msg}\n${stderr}\n${stdout}`.trim() };
        }
      }

      if (name === "code_search") {
        if (!roots.length) return { ok: false, name, content: "No fsRoots configured." };
        const pattern = safeString(args?.pattern).trim();
        if (!pattern) return { ok: false, name, content: "Missing pattern." };
        const glob = safeString(args?.glob).trim() || "**/*";
        const maxResults = clampInt(args?.maxResults ?? 50, 1, 200, 50);
        const contextLines = clampInt(args?.contextLines ?? 2, 0, 10, 2);

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, "gi");
        } catch {
          return { ok: false, name, content: "Invalid regex pattern." };
        }

        const files = listFilesRecursive(roots[0], 1000).filter((p) => matchSimpleGlob(p, glob));
        const matches: string[] = [];

        for (const p of files) {
          if (matches.length >= maxResults) break;
          let text = "";
          try {
            text = readTextWithLimit(p, Math.min(200_000, maxReadBytes));
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            if (regex.test(lines[i])) {
              regex.lastIndex = 0; // reset for next test
              const rel = p.slice(roots[0].length).replace(/^\\+/, "").replace(/^\//, "") || ".";
              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              const context = lines.slice(start, end + 1).map((l, idx) => {
                const lineNum = start + idx + 1;
                const marker = lineNum === i + 1 ? ">" : " ";
                return `${marker}${lineNum}: ${l}`;
              }).join("\n");
              matches.push(`${rel}:${i + 1}\n${context}`);
            }
          }
        }
        return { ok: true, name, content: matches.join("\n\n") || "(no matches)" };
      }

      if (name === "code_edit") {
        if (!roots.length) return { ok: false, name, content: "No fsRoots configured." };
        const p = safeString(args?.path).trim();
        if (!p) return { ok: false, name, content: "Missing path." };
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        if (!edits.length) return { ok: false, name, content: "Missing edits." };

        const resolved = pickFirstRootedPath(roots, p);
        if (!resolved) return { ok: false, name, content: "Path is outside fsRoots." };
        if (!existsSync(resolved)) return { ok: false, name, content: "File not found." };
        if (!statSync(resolved).isFile()) return { ok: false, name, content: "Not a file." };

        let content = readFileSync(resolved, "utf-8");
        let applied = 0;

        for (const edit of edits) {
          const search = safeString(edit?.search);
          const replace = safeString(edit?.replace);
          if (!search) continue;
          if (content.includes(search)) {
            content = content.replace(search, replace);
            applied++;
          }
        }

        if (applied === 0) {
          return { ok: false, name, content: "No edits matched." };
        }

        writeFileSync(resolved, content, "utf-8");
        return { ok: true, name, content: `Applied ${applied} edit(s) to ${p}` };
      }

      if (name === "git_status") {
        const cwd = safeString(args?.cwd).trim() || (roots.length ? roots[0] : process.cwd());
        try {
          const output = execSync("git status --porcelain -b", {
            cwd,
            timeout: 10000,
            encoding: "utf-8"
          });
          return { ok: true, name, content: String(output).trim() || "(clean)" };
        } catch (err: any) {
          return { ok: false, name, content: `git status failed: ${err?.message || err}` };
        }
      }

      if (name === "git_diff") {
        const cwd = safeString(args?.cwd).trim() || (roots.length ? roots[0] : process.cwd());
        const staged = Boolean(args?.staged);
        const commit = safeString(args?.commit).trim();
        const path = safeString(args?.path).trim();

        let cmd = "git diff";
        if (staged) cmd += " --cached";
        if (commit) cmd += ` ${commit}`;
        if (path) cmd += ` -- "${path}"`;

        try {
          const output = execSync(cmd, {
            cwd,
            timeout: 15000,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024
          });
          return { ok: true, name, content: String(output).slice(0, 80000) || "(no changes)" };
        } catch (err: any) {
          return { ok: false, name, content: `git diff failed: ${err?.message || err}` };
        }
      }

      if (name === "git_log") {
        const cwd = safeString(args?.cwd).trim() || (roots.length ? roots[0] : process.cwd());
        const maxCount = clampInt(args?.maxCount ?? 10, 1, 100, 10);
        const oneline = Boolean(args?.oneline ?? true);

        let cmd = `git log -n ${maxCount}`;
        if (oneline) cmd += " --oneline";

        try {
          const output = execSync(cmd, {
            cwd,
            timeout: 10000,
            encoding: "utf-8"
          });
          return { ok: true, name, content: String(output).trim() || "(no commits)" };
        } catch (err: any) {
          return { ok: false, name, content: `git log failed: ${err?.message || err}` };
        }
      }

      if (name === "memory_store") {
        // This is a placeholder - actual implementation requires MemoryService injection
        const key = safeString(args?.key).trim();
        const content = safeString(args?.content).trim();
        if (!key) return { ok: false, name, content: "Missing key." };
        if (!content) return { ok: false, name, content: "Missing content." };
        // Return success - actual storage handled by CoreService
        return { ok: true, name, content: `Memory stored: ${key}` };
      }

      if (name === "memory_query") {
        // This is a placeholder - actual implementation requires MemoryService injection
        const query = safeString(args?.query).trim();
        const key = safeString(args?.key).trim();
        if (!query && !key) return { ok: false, name, content: "Missing query or key." };
        // Return placeholder - actual query handled by CoreService
        return { ok: true, name, content: "(memory query placeholder - handled by CoreService)" };
      }

      return { ok: false, name, content: `Unknown tool: ${name}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, name, content: `Tool error: ${msg}` };
    }
  }
}
