import { powerMonitor } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SensorUpdate } from "@sama/shared";
import type { AppConfig } from "../protocol/types";

type ActiveWinLike = {
  owner?: { name?: string };
  title?: string;
};

function safeParseConfig(configPath: string): AppConfig {
  const defaults: AppConfig = { socialApps: ["WeChat.exe", "QQ.exe", "Telegram.exe", "Discord.exe"] };

  const base: any = (() => {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

  const localPath = resolve(dirname(configPath), "config.local.json");
  const local: any = (() => {
    try {
      if (!existsSync(localPath)) return {};
      const raw = readFileSync(localPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  })();

  const socialApps = Array.isArray(local.socialApps)
    ? local.socialApps
    : Array.isArray(base.socialApps)
      ? base.socialApps
      : defaults.socialApps;

  return { socialApps };
}

function isNightNow(ts: number) {
  const d = new Date(ts);
  const h = d.getHours();
  return h >= 0 && h < 6;
}

export class SensingService {
  #timer: NodeJS.Timeout | null = null;
  #emitTimer: NodeJS.Timeout | null = null;
  #onUpdate: (u: SensorUpdate) => void;
  #configPath: string;
  #config: AppConfig;

  #lastActiveApp: string | null = null;
  #lastActiveTitle: string | undefined = undefined;
  #switchEvents: number[] = [];
  #socialHits: number[] = [];

  #activeWinFn: (() => Promise<ActiveWinLike | undefined>) | null = null;

  constructor(opts: { onUpdate: (u: SensorUpdate) => void; configPath: string }) {
    this.#onUpdate = opts.onUpdate;
    this.#configPath = opts.configPath;
    this.#config = safeParseConfig(this.#configPath);
  }

  async #lazyLoadDeps() {
    if (!this.#activeWinFn) {
      try {
        const mod: any = await import("active-win");
        const fn = (mod.default ?? mod) as () => Promise<ActiveWinLike | undefined>;
        this.#activeWinFn = fn;
      } catch (err) {
        console.warn("[sensing] active-win unavailable, fallback to stub:", err);
        this.#activeWinFn = async () => ({ owner: { name: "Unknown.exe" }, title: "" });
      }
    }
  }

  start() {
    void this.#lazyLoadDeps();

    this.#timer = setInterval(async () => {
      await this.#lazyLoadDeps();

      const now = Date.now();
      try {
        const info = await this.#activeWinFn?.();
        const activeApp = info?.owner?.name ?? "Unknown.exe";
        const activeTitle = info?.title;

        if (this.#lastActiveApp && activeApp !== this.#lastActiveApp) {
          this.#switchEvents.push(now);
        }

        const isSocial = this.#config.socialApps.includes(activeApp);
        if (isSocial && activeApp !== this.#lastActiveApp) {
          this.#socialHits.push(now);
        }

        this.#lastActiveApp = activeApp;
        this.#lastActiveTitle = activeTitle;
      } catch (err) {
        console.warn("[sensing] poll error:", err);
      }
    }, 400);

    this.#emitTimer = setInterval(async () => {
      await this.#lazyLoadDeps();

      const now = Date.now();
      const twoMinAgo = now - 2 * 60_000;
      const threeMinAgo = now - 3 * 60_000;

      this.#switchEvents = this.#switchEvents.filter((t) => t >= twoMinAgo);
      this.#socialHits = this.#socialHits.filter((t) => t >= threeMinAgo);

      // Electron provides a built-in, Windows-friendly idle time API.
      const idleSec = Math.max(0, Math.floor(powerMonitor.getSystemIdleTime?.() ?? 0));
      const activeApp = this.#lastActiveApp ?? "Unknown.exe";

      const u: SensorUpdate = {
        type: "SENSOR_UPDATE",
        ts: now,
        activeApp,
        activeTitle: this.#lastActiveTitle,
        switchRate2m: this.#switchEvents.length,
        socialHits3m: this.#socialHits.length,
        idleSec,
        isNight: isNightNow(now)
      };

      this.#onUpdate(u);
    }, 1000);
  }

  reloadConfig() {
    this.#config = safeParseConfig(this.#configPath);
  }

  dispose() {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#emitTimer) clearInterval(this.#emitTimer);
    this.#timer = null;
    this.#emitTimer = null;
  }

  static defaultConfigPath() {
    // When launched via `pnpm --filter @sama/stage-desktop dev`, cwd is the package root.
    return resolve(process.cwd(), "config.json");
  }
}
