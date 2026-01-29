import { clamp } from "./utils";

export type MotionUiSettingsV1 = {
  version: 1;
  vrma: { speed: number; paused: boolean };
  idle: { enabled: boolean; strength: number; speed: number };
  walk: { enabled: boolean; speed: number; stride: number };
};

const MOTION_UI_KEY = "sama.ui.motion.v1";

export function loadMotionUiSettings(): MotionUiSettingsV1 {
  try {
    const raw = localStorage.getItem(MOTION_UI_KEY);
    const parsed = raw ? (JSON.parse(raw) as any) : null;
    if (!parsed || parsed.version !== 1) throw new Error("bad version");
    return {
      version: 1,
      vrma: {
        speed: clamp(Number(parsed?.vrma?.speed ?? 1), 0, 2),
        paused: Boolean(parsed?.vrma?.paused ?? false)
      },
      idle: {
        enabled: Boolean(parsed?.idle?.enabled ?? true),
        strength: clamp(Number(parsed?.idle?.strength ?? 1), 0, 1),
        speed: clamp(Number(parsed?.idle?.speed ?? 1), 0.2, 2)
      },
      walk: {
        enabled: Boolean(parsed?.walk?.enabled ?? true),
        speed: clamp(Number(parsed?.walk?.speed ?? 1), 0.2, 2),
        stride: clamp(Number(parsed?.walk?.stride ?? 0.75), 0, 1)
      }
    };
  } catch {
    return {
      version: 1,
      vrma: { speed: 1, paused: false },
      idle: { enabled: true, strength: 1, speed: 1 },
      walk: { enabled: true, speed: 1, stride: 0.75 }
    };
  }
}

export function saveMotionUiSettings(s: MotionUiSettingsV1) {
  try {
    localStorage.setItem(MOTION_UI_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

