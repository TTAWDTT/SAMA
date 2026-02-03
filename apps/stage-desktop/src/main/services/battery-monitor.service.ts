import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

type BatteryStatus = { percent: number; charging: boolean };

async function getBatteryStatus(): Promise<BatteryStatus | null> {
  const platform = process.platform;

  if (platform === "win32") {
    try {
      const ps = [
        "$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus;",
        "if (-not $b) { exit 0 };",
        "$p = [int]($b.EstimatedChargeRemaining);",
        "$s = [int]($b.BatteryStatus);",
        "$charging = $false;",
        // BatteryStatus (rough): 2/3/6/7/8/9/11 usually indicate AC/charging/full.
        "if ($s -in 2,3,6,7,8,9,11) { $charging = $true };",
        "Write-Output (\"{\\\"percent\\\":\" + $p + \",\\\"charging\\\":\" + ($charging.ToString().ToLower()) + \"}\");"
      ].join(" ");

      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 3000, windowsHide: true }
      );

      const out = String(stdout ?? "").trim();
      if (!out) return null;
      const parsed = JSON.parse(out);
      const percent = Math.max(0, Math.min(100, Math.floor(Number(parsed?.percent) || 0)));
      const charging = Boolean(parsed?.charging);
      if (!Number.isFinite(percent)) return null;
      return { percent, charging };
    } catch {
      return null;
    }
  }

  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("pmset", ["-g", "batt"], { timeout: 2500 });
      const out = String(stdout ?? "");
      const m = out.match(/(\d+)%/);
      if (!m?.[1]) return null;
      const percent = Math.max(0, Math.min(100, Math.floor(Number(m[1]) || 0)));
      const charging = /charging|charged/i.test(out) && !/discharging/i.test(out);
      return { percent, charging };
    } catch {
      return null;
    }
  }

  // linux (best-effort): /sys/class/power_supply/BAT0
  if (platform === "linux") {
    try {
      const cap = await readFile("/sys/class/power_supply/BAT0/capacity", "utf-8");
      const status = await readFile("/sys/class/power_supply/BAT0/status", "utf-8");
      const percent = Math.max(0, Math.min(100, Math.floor(Number(String(cap).trim()) || 0)));
      const charging = /charging|full/i.test(String(status ?? "").trim());
      return { percent, charging };
    } catch {
      return null;
    }
  }

  return null;
}

export class BatteryMonitorService {
  #timer: NodeJS.Timeout | null = null;
  #pollMs: number;
  #onSignal: (signal: any) => void;
  #notified50 = false;
  #notified20 = false;

  constructor(opts: { pollMs?: number; onSignal: (signal: any) => void }) {
    const ms = Math.floor(Number(opts.pollMs) || 0);
    this.#pollMs = ms > 0 ? Math.max(10_000, Math.min(5 * 60_000, ms)) : 60_000;
    this.#onSignal = opts.onSignal;
  }

  start() {
    if (this.#timer) return;

    const tick = async () => {
      const s = await getBatteryStatus();
      if (!s) return;

      // Reset "threshold fired" flags after we start charging again.
      if (s.charging) {
        this.#notified50 = false;
        this.#notified20 = false;
        return;
      }

      const ts = Date.now();
      if (!this.#notified50 && s.percent <= 50) {
        this.#notified50 = true;
        this.#onSignal({ kind: "SYSTEM_BATTERY", ts, percent: s.percent, charging: s.charging, threshold: 50 });
      }
      if (!this.#notified20 && s.percent <= 20) {
        this.#notified20 = true;
        this.#onSignal({ kind: "SYSTEM_BATTERY", ts, percent: s.percent, charging: s.charging, threshold: 20 });
      }
    };

    // Run once quickly, then poll.
    void tick();
    this.#timer = setInterval(() => void tick(), this.#pollMs);
  }

  dispose() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

