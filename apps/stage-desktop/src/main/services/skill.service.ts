import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export type SkillInfo = {
  name: string;
  path: string;
};

function safeReadText(p: string) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

export class SkillService {
  #skillsDir: string;
  #cache: Map<string, { mtimeMs: number; text: string }> = new Map();

  constructor(opts?: { skillsDir?: string }) {
    const fromEnv = String(process.env.SAMA_SKILLS_DIR ?? "").trim();
    this.#skillsDir = opts?.skillsDir || fromEnv || join(os.homedir(), ".claude", "skills");
  }

  get skillsDir() {
    return this.#skillsDir;
  }

  listSkills(): SkillInfo[] {
    try {
      if (!existsSync(this.#skillsDir)) return [];
      const entries = readdirSync(this.#skillsDir, { withFileTypes: true });
      const out: SkillInfo[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        const p = join(this.#skillsDir, name, "SKILL.md");
        if (!existsSync(p)) continue;
        out.push({ name, path: p });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch {
      return [];
    }
  }

  readSkillMarkdown(name: string): string {
    const p = join(this.#skillsDir, name, "SKILL.md");
    if (!existsSync(p)) return "";
    return safeReadText(p);
  }

  /**
   * Render enabled skills into a single prompt segment.
   * Keep it conservative to avoid blowing up context; if you need full bodies,
   * enable fewer skills at a time.
   */
  renderSkillsPrompt(enabled: string[], opts?: { maxChars?: number }): string {
    const maxChars = Math.max(4_000, Math.floor(Number(opts?.maxChars ?? 30_000)));
    const names = Array.isArray(enabled) ? enabled.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!names.length) return "";

    let out = "";
    for (const name of names) {
      const md = this.readSkillMarkdown(name);
      if (!md.trim()) continue;

      const next =
        `\n\n=== SKILL: ${name} ===\n` +
        md.trim();

      if ((out.length + next.length) > maxChars) {
        // Stop adding more skills once we hit budget.
        break;
      }
      out += next;
    }

    return out.trim();
  }
}

