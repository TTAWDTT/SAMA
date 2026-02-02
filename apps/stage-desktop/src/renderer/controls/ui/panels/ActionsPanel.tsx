import type { ActionCommand, PetDisplayModeConfig, PetStateMessage, PetWindowStateMessage } from "@sama/shared";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { StageDesktopApi } from "../api";
import { pickFileViaFileInput } from "../lib/filePicker";
import { loadMotionUiSettings, saveMotionUiSettings, type MotionUiSettingsV1 } from "../lib/motionUi";
import { sendPetControl, sendPetControlWithResult } from "../lib/petControl";
import { clamp } from "../lib/utils";
import {
  bytesToArrayBuffer,
  normalizeVrmaName,
  stripExtension,
  vrmaDelete,
  vrmaGet,
  vrmaList,
  vrmaPut,
  type VrmaLibraryItem
} from "../lib/vrmaDb";
import { VRMA_PRESETS, loadPresetBytes, type VrmaPreset } from "../lib/vrmaPresets";

const LS_QUIET = "sama.ui.quietMode.v1";
const LS_PRESET_CAROUSEL = "sama.ui.vrma.presetCarousel.v1";
const LS_FRAME_ENABLED = "sama.ui.frame.enabled.v1";
const LS_FRAME_SIZE = "sama.ui.frame.size.v1";
const LS_FRAME_RADIUS = "sama.ui.frame.radius.v1";
const LS_FRAME_COLOR = "sama.ui.frame.color.v1";

function loadQuietMode() {
  try {
    return localStorage.getItem(LS_QUIET) === "1";
  } catch {
    return false;
  }
}

function saveQuietMode(v: boolean) {
  try {
    localStorage.setItem(LS_QUIET, v ? "1" : "0");
  } catch {}
}

function loadPresetCarouselEnabled() {
  try {
    const v = localStorage.getItem(LS_PRESET_CAROUSEL);
    // Default: enabled (action showcase).
    if (v === null) return true;
    return v === "1";
  } catch {
    return true;
  }
}

function savePresetCarouselEnabled(v: boolean) {
  try {
    localStorage.setItem(LS_PRESET_CAROUSEL, v ? "1" : "0");
  } catch {}
}

// Frame settings loaders/savers
function loadFrameEnabled() {
  try {
    return localStorage.getItem(LS_FRAME_ENABLED) === "1";
  } catch {
    return false;
  }
}

function saveFrameEnabled(v: boolean) {
  try {
    localStorage.setItem(LS_FRAME_ENABLED, v ? "1" : "0");
  } catch {}
}

function loadFrameSize() {
  try {
    const v = parseInt(localStorage.getItem(LS_FRAME_SIZE) || "", 10);
    if (v >= 1 && v <= 10) return v;
  } catch {}
  return 3;
}

function saveFrameSize(v: number) {
  try {
    localStorage.setItem(LS_FRAME_SIZE, String(v));
  } catch {}
}

function loadFrameRadius() {
  try {
    const v = parseInt(localStorage.getItem(LS_FRAME_RADIUS) || "", 10);
    if (v >= 0 && v <= 50) return v;
  } catch {}
  return 12;
}

function saveFrameRadius(v: number) {
  try {
    localStorage.setItem(LS_FRAME_RADIUS, String(v));
  } catch {}
}

function loadFrameColor() {
  try {
    return localStorage.getItem(LS_FRAME_COLOR) || "#d97757";
  } catch {
    return "#d97757";
  }
}

function saveFrameColor(v: string) {
  try {
    localStorage.setItem(LS_FRAME_COLOR, v);
  } catch {}
}

function sendManual(api: StageDesktopApi | null, payload: any) {
  const fn = api?.sendManualAction;
  if (typeof fn === "function") {
    try {
      fn(payload);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function buildCmd(partial: Partial<ActionCommand> & Pick<ActionCommand, "action">): ActionCommand {
  const ts = Date.now();
  return {
    type: "ACTION_COMMAND",
    ts,
    action: partial.action,
    expression: (partial.expression as any) ?? "NEUTRAL",
    bubbleKind: partial.bubbleKind,
    bubble: partial.bubble ?? null,
    durationMs: clamp(Number(partial.durationMs ?? 1500), 0, 25_000)
  };
}

type SlotsState = {
  hasIdle: boolean;
  hasWalk: boolean;
  hasAction: boolean;
  hasLastLoaded: boolean;
};

export function ActionsPanel(props: { api: StageDesktopApi | null; onToast: (msg: string, o?: any) => void }) {
  const { api, onToast } = props;

  const [quiet, setQuiet] = useState(loadQuietMode);
  const [presetCarousel, setPresetCarousel] = useState(loadPresetCarouselEnabled);

  // SAMA display frame settings
  const [frameEnabled, setFrameEnabled] = useState(loadFrameEnabled);
  const [frameSize, setFrameSize] = useState(loadFrameSize);
  const [frameRadius, setFrameRadius] = useState(loadFrameRadius);
  const [frameColor, setFrameColor] = useState(loadFrameColor);
  const [framePreviewing, setFramePreviewing] = useState(false);

  const [displayMode, setDisplayMode] = useState<PetDisplayModeConfig>({ mode: "normal" });

  const [slots, setSlots] = useState<SlotsState>({
    hasIdle: false,
    hasWalk: false,
    hasAction: false,
    hasLastLoaded: false
  });

  const [motionUi, setMotionUi] = useState<MotionUiSettingsV1>(loadMotionUiSettings);

  const [lastVrmaBytes, setLastVrmaBytes] = useState<Uint8Array | null>(null);
  const [lastVrmaFileName, setLastVrmaFileName] = useState<string>("");
  const [vrmaStatus, setVrmaStatus] = useState<string>("最近：—");
  const [vrmaSaveName, setVrmaSaveName] = useState<string>("");

  const [libLoading, setLibLoading] = useState(false);
  const [library, setLibrary] = useState<VrmaLibraryItem[]>([]);
  const [presetLoading, setPresetLoading] = useState<string | null>(null);
  const presetLoadingRef = useRef<string | null>(null);

  const pendingVrmaCfg = useRef<any>({});
  const vrmaCfgTimer = useRef<number | null>(null);
  const pendingIdleCfg = useRef<any>({});
  const idleCfgTimer = useRef<number | null>(null);
  const pendingWalkCfg = useRef<any>({});
  const walkCfgTimer = useRef<number | null>(null);
  const presetCarouselTimer = useRef<number | null>(null);
  const presetCarouselIdx = useRef<number>(0);
  const pendingFrameCfg = useRef<any>({});
  const frameCfgTimer = useRef<number | null>(null);

  useEffect(() => saveQuietMode(quiet), [quiet]);
  useEffect(() => savePresetCarouselEnabled(presetCarousel), [presetCarousel]);

  // Throttled frame config sender for smooth slider experience
  function queueFrameConfig(cfg: { enabled?: boolean; size?: number; radius?: number; color?: string; previewing?: boolean }) {
    pendingFrameCfg.current = { ...pendingFrameCfg.current, ...cfg };
    if (frameCfgTimer.current !== null) return;
    frameCfgTimer.current = window.setTimeout(() => {
      frameCfgTimer.current = null;
      const finalCfg = pendingFrameCfg.current;
      pendingFrameCfg.current = {};
      sendPetControl(api, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_FRAME_CONFIG",
        config: finalCfg
      } as any);
    }, 16); // ~60fps throttle for smooth updates
  }

  // End preview mode (called on slider release)
  function endFramePreview() {
    setFramePreviewing(false);
    queueFrameConfig({ previewing: false });
  }

  // Start preview mode (called on slider interaction)
  function startFramePreview() {
    if (!framePreviewing) {
      setFramePreviewing(true);
    }
  }

  // Save frame settings (debounced persistence, immediate local state)
  useEffect(() => {
    saveFrameEnabled(frameEnabled);
    queueFrameConfig({ enabled: frameEnabled, size: frameSize, radius: frameRadius, color: frameColor, previewing: framePreviewing });
  }, [frameEnabled]);

  useEffect(() => {
    saveFrameSize(frameSize);
    queueFrameConfig({ size: frameSize, previewing: framePreviewing });
  }, [frameSize]);

  useEffect(() => {
    saveFrameRadius(frameRadius);
    queueFrameConfig({ radius: frameRadius, previewing: framePreviewing });
  }, [frameRadius]);

  useEffect(() => {
    saveFrameColor(frameColor);
    queueFrameConfig({ color: frameColor, previewing: framePreviewing });
  }, [frameColor]);

  useEffect(() => {
    if (!api || typeof api.onPetState !== "function") return;
    return api.onPetState((s: PetStateMessage) => {
      const next: any = (s as any)?.slots ?? null;
      if (!next) return;
      setSlots({
        hasIdle: Boolean(next.hasIdle),
        hasWalk: Boolean(next.hasWalk),
        hasAction: Boolean(next.hasAction),
        hasLastLoaded: Boolean(next.hasLastLoaded)
      });
    });
  }, [api]);

  // Listen for pet window state to sync display mode
  useEffect(() => {
    if (!api || typeof api.onPetWindowState !== "function") return;
    return api.onPetWindowState((s: PetWindowStateMessage) => {
      if (s?.displayMode) {
        setDisplayMode(s.displayMode);
      }
    });
  }, [api]);

  const slotStatusText = useMemo(() => {
    const idleMark = slots.hasIdle ? "✓" : "-";
    const walkMark = slots.hasWalk ? "✓" : "-";
    const actMark = slots.hasAction ? "✓" : "-";
    return `idle ${idleMark} · walk ${walkMark} · act ${actMark}`;
  }, [slots]);

  const doAction = (cmd: ActionCommand) => {
    const ok = sendManual(api, { type: "MANUAL_ACTION", ts: Date.now(), action: cmd.action, expression: cmd.expression });
    if (!ok) {
      // Fallback: expression-only via PetControl (no window movement).
      try {
        api?.sendPetControl?.({ type: "PET_CONTROL", ts: Date.now(), action: "NOTIFY_ACTION", cmd } as any);
        onToast("已发送（fallback）", { timeoutMs: 1200 });
      } catch {
        onToast("preload API 缺失：无法发送动作", { timeoutMs: 4200 });
      }
    }
  };

  function queueVrmaConfig(partial: any) {
    pendingVrmaCfg.current = { ...pendingVrmaCfg.current, ...partial };
    if (vrmaCfgTimer.current !== null) return;
    vrmaCfgTimer.current = window.setTimeout(() => {
      vrmaCfgTimer.current = null;
      const cfg = pendingVrmaCfg.current;
      pendingVrmaCfg.current = {};
      sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "SET_VRMA_CONFIG", config: cfg } as any);
    }, 60);
  }

  function queueIdleConfig(partial: any) {
    pendingIdleCfg.current = { ...pendingIdleCfg.current, ...partial };
    if (idleCfgTimer.current !== null) return;
    idleCfgTimer.current = window.setTimeout(() => {
      idleCfgTimer.current = null;
      const cfg = pendingIdleCfg.current;
      pendingIdleCfg.current = {};
      sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "SET_IDLE_CONFIG", config: cfg } as any);
    }, 60);
  }

  function queueWalkConfig(partial: any) {
    pendingWalkCfg.current = { ...pendingWalkCfg.current, ...partial };
    if (walkCfgTimer.current !== null) return;
    walkCfgTimer.current = window.setTimeout(() => {
      walkCfgTimer.current = null;
      const cfg = pendingWalkCfg.current;
      pendingWalkCfg.current = {};
      sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "SET_WALK_CONFIG", config: cfg } as any);
    }, 60);
  }

  async function loadVrmaBytes(bytes: Uint8Array) {
    const res = await sendPetControlWithResult(
      api,
      { type: "PET_CONTROL", ts: Date.now(), action: "LOAD_VRMA_BYTES", bytes } as any,
      { timeoutMs: 12_000 }
    );
    if (!res.ok) throw new Error(String(res.message ?? "load failed"));
  }

  async function refreshLibrary() {
    setLibLoading(true);
    try {
      const items = await vrmaList();
      setLibrary(items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`动作库读取失败：${msg}`, { timeoutMs: 5200 });
      setLibrary([]);
    } finally {
      setLibLoading(false);
    }
  }

  async function playPreset(preset: VrmaPreset, opts?: { silent?: boolean }) {
    if (presetLoadingRef.current) return;
    presetLoadingRef.current = preset.id;
    setPresetLoading(preset.id);
    try {
      const bytes = await loadPresetBytes(preset);
      await loadVrmaBytes(bytes);
      setVrmaStatus(`预设：${preset.name}（已加载）`);
      if (!opts?.silent) onToast(`已播放：${preset.name}`, { timeoutMs: 1600 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setVrmaStatus(`预设：${preset.name}（失败）`);
      if (!opts?.silent) onToast(`加载预设动作失败：${msg}`, { timeoutMs: 5200 });
    } finally {
      presetLoadingRef.current = null;
      setPresetLoading(null);
    }
  }

  // Default: auto carousel preset motions (action showcase).
  useEffect(() => {
    if (!presetCarousel) {
      if (presetCarouselTimer.current !== null) {
        window.clearTimeout(presetCarouselTimer.current);
        presetCarouselTimer.current = null;
      }
      return;
    }
    if (!api) return;
    if (!VRMA_PRESETS.length) return;

    let cancelled = false;
    const intervalMs = 10_000;

    const schedule = () => {
      if (cancelled) return;
      presetCarouselTimer.current = window.setTimeout(async () => {
        if (cancelled) return;
        const preset = VRMA_PRESETS[presetCarouselIdx.current % VRMA_PRESETS.length] ?? VRMA_PRESETS[0]!;
        presetCarouselIdx.current = (presetCarouselIdx.current + 1) % VRMA_PRESETS.length;
        try {
          await playPreset(preset, { silent: true });
        } catch {
          // ignore; toast already handled by playPreset
        }
        schedule();
      }, intervalMs);
    };

    // Kick off quickly on mount / toggle-on, then continue on a fixed cadence.
    presetCarouselTimer.current = window.setTimeout(() => {
      // Reuse the same code path as schedule() but without waiting full interval.
      void (async () => {
        if (cancelled) return;
        const preset = VRMA_PRESETS[presetCarouselIdx.current % VRMA_PRESETS.length] ?? VRMA_PRESETS[0]!;
        presetCarouselIdx.current = (presetCarouselIdx.current + 1) % VRMA_PRESETS.length;
        try {
          await playPreset(preset, { silent: true });
        } catch {}
        schedule();
      })();
    }, 600);

    return () => {
      cancelled = true;
      if (presetCarouselTimer.current !== null) {
        window.clearTimeout(presetCarouselTimer.current);
        presetCarouselTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, presetCarousel]);

  function toggleDisplayMode() {
    const nextMode = displayMode.mode === "normal" ? "peek" : "normal";
    setDisplayMode((prev) => ({ ...prev, mode: nextMode, ...(nextMode === "peek" ? { edge: "bottom" } : {}) }));
    sendPetControl(api, {
      type: "PET_CONTROL",
      ts: Date.now(),
      action: "SET_DISPLAY_MODE",
      config: nextMode === "peek" ? { mode: "peek", edge: "bottom" } : { mode: "normal" }
    } as any);
    onToast(nextMode === "peek" ? "探出小脑袋模式" : "普通模式", { timeoutMs: 1600 });
  }

  async function savePresetToLibrary(preset: VrmaPreset) {
    try {
      const existing = await vrmaGet(preset.name);
      if (existing) {
        onToast(`动作库已存在「${preset.name}」`, { timeoutMs: 2000 });
        return;
      }

      const bytes = await loadPresetBytes(preset);
      const now = Date.now();
      await vrmaPut({
        name: preset.name,
        bytes: bytesToArrayBuffer(bytes),
        createdAt: now,
        updatedAt: now
      });
      await refreshLibrary();
      onToast(`已保存到动作库：${preset.name}`, { timeoutMs: 2000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`保存失败：${msg}`, { timeoutMs: 5200 });
    }
  }

  useEffect(() => {
    void refreshLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">Actions / Motion</div>
          <div className="panelSub">手动互动 + 动作（VRMA）+ 程序动作兜底。</div>
        </div>
      </div>

      {/* Manual actions */}
      <div className="card">
        <div className="btnRow">
          <button className="btn btnPrimary" type="button" onClick={() => doAction(buildCmd({ action: "APPROACH", durationMs: 1500 }))}>
            靠近一点
          </button>
          <button className="btn" type="button" onClick={() => doAction(buildCmd({ action: "RETREAT", durationMs: 1500 }))}>
            离远一点
          </button>
          <button
            className={`btn ${displayMode.mode === "peek" ? "btnPrimary" : ""}`}
            type="button"
            onClick={toggleDisplayMode}
          >
            {displayMode.mode === "peek" ? "普通模式" : "探出小脑袋"}
          </button>
        </div>

        {displayMode.mode === "peek" ? (
          <>
            <div className="divider" />

            <div className="field">
              <div className="label">探出小脑袋</div>
              <div className="help">靠在桌面底边，只露出脑袋；拖动角色可以左右移动。</div>
            </div>
          </>
        ) : null}

        <div className="divider" />

        <label className="switchRow">
          <input
            type="checkbox"
            checked={quiet}
            onChange={(e) => {
              const v = Boolean(e.target.checked);
              setQuiet(v);
              onToast(v ? "安静模式：UI 已记录（核心暂未接入）" : "安静模式：关闭", { timeoutMs: 1600 });
            }}
          />
          <span className="switchLabel">安静模式（UI 开关）</span>
        </label>
        <div className="help">说明：该开关目前只在 UI 侧保存状态；后续可接入 core 的主动行为。</div>

        <div className="divider" />

        <div className="field">
          <div className="label">Expression</div>
          <div className="chipRow chipRowWrap">
            {(["NEUTRAL", "HAPPY", "SAD", "SHY", "TIRED", "ANGRY", "SURPRISED", "THINKING", "CONFUSED", "EXCITED"] as ActionCommand["expression"][]).map((x) => (
              <button
                key={x}
                className="chip"
                type="button"
                onClick={() => doAction(buildCmd({ action: "IDLE", expression: x, durationMs: 1200 }))}
              >
                {x}
              </button>
            ))}
          </div>
          <div className="help">表情会立即在角色上生效（用于测试）。</div>
        </div>

        <div className="divider" />

        {/* Camera Presets */}
        <div className="field">
          <div className="label">相机预设</div>
          <div className="chipRow">
            {(["full", "half", "closeup", "face"] as const).map((preset) => (
              <button
                key={preset}
                className="chip"
                type="button"
                onClick={() => {
                  sendPetControl(api, {
                    type: "PET_CONTROL",
                    ts: Date.now(),
                    action: "SET_CAMERA_PRESET",
                    preset
                  } as any);
                  onToast(`相机：${preset === "full" ? "全身" : preset === "half" ? "半身" : preset === "closeup" ? "特写" : "面部"}`, { timeoutMs: 1200 });
                }}
              >
                {preset === "full" ? "全身" : preset === "half" ? "半身" : preset === "closeup" ? "特写" : "面部"}
              </button>
            ))}
          </div>
          <div className="help">一键切换相机视角。</div>
        </div>

        {/* Screenshot */}
        <div className="field">
          <div className="label">截图</div>
          <button
            className="btn btnSm"
            type="button"
            onClick={async () => {
              const requestId = `screenshot-${Date.now()}`;
              sendPetControlWithResult(api, {
                type: "PET_CONTROL",
                ts: Date.now(),
                requestId,
                action: "TAKE_SCREENSHOT"
              } as any).then((result) => {
                if (result.ok && result.message) {
                  // Create download link
                  const link = document.createElement("a");
                  link.href = result.message;
                  link.download = `SAMA-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")}.png`;
                  link.click();
                  onToast("截图已保存", { timeoutMs: 1600 });
                } else {
                  onToast("截图失败", { timeoutMs: 2000 });
                }
              }).catch(() => {
                onToast("截图失败", { timeoutMs: 2000 });
              });
            }}
          >
            📷 保存截图
          </button>
          <div className="help">保存当前角色姿势为 PNG 图片。</div>
        </div>
      </div>

      {/* SAMA Display Frame */}
      <div className="card">
        <div className="field">
          <div className="label">展示区域边框</div>
          <div className="help">当鼠标悬停在 SAMA 展示区域时显示边框，可调节边框大小和样式。</div>
        </div>

        <label className="switchRow" style={{ marginTop: 12 }}>
          <input
            type="checkbox"
            checked={frameEnabled}
            onChange={(e) => {
              const v = Boolean(e.target.checked);
              setFrameEnabled(v);
              onToast(v ? "边框已启用" : "边框已禁用", { timeoutMs: 1400 });
            }}
          />
          <span className="switchLabel">启用悬停边框</span>
        </label>

        {frameEnabled && (
          <div className="samaFrameControl">
            <div className="framePreview hasFrame" style={{
              borderWidth: `${frameSize}px`,
              borderColor: frameColor,
              borderRadius: `${frameRadius}px`
            }}>
              <div className="framePreviewInner" style={{ borderRadius: `${Math.max(0, frameRadius - 4)}px` }} />
            </div>

            <div className="field">
              <div className="label">边框粗细</div>
              <div className="frameSliderRow">
                <input
                  className="range"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={frameSize}
                  onMouseDown={startFramePreview}
                  onMouseUp={endFramePreview}
                  onBlur={endFramePreview}
                  onChange={(e) => setFrameSize(clamp(Number(e.target.value), 1, 10))}
                />
                <span className="frameValue">{frameSize}px</span>
              </div>
            </div>

            <div className="field">
              <div className="label">边框圆角</div>
              <div className="frameSliderRow">
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={frameRadius}
                  onMouseDown={startFramePreview}
                  onMouseUp={endFramePreview}
                  onBlur={endFramePreview}
                  onChange={(e) => setFrameRadius(clamp(Number(e.target.value), 0, 50))}
                />
                <span className="frameValue">{frameRadius}px</span>
              </div>
            </div>

            <div className="field">
              <div className="label">边框颜色</div>
              <div className="row">
                <input
                  type="color"
                  value={frameColor}
                  onChange={(e) => setFrameColor(e.target.value)}
                  style={{ width: 48, height: 36, padding: 2, borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer' }}
                />
                <input
                  className="input"
                  type="text"
                  value={frameColor}
                  onChange={(e) => setFrameColor(e.target.value)}
                  style={{ flex: 1 }}
                  placeholder="#d97757"
                />
              </div>
            </div>

            <div className="chipRow" style={{ marginTop: 12 }}>
              {["#d97757", "#6a9bcc", "#788c5d", "#8b5cf6", "#ec4899", "#f59e0b"].map((color) => (
                <button
                  key={color}
                  type="button"
                  className="chip"
                  style={{
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: color,
                    border: frameColor === color ? '2px solid var(--text)' : '2px solid transparent'
                  }}
                  onClick={() => setFrameColor(color)}
                  title={color}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* VRMA */}
      <div className="card">
        <div className="field">
          <div className="label">动作（VRMA）</div>
          <div className="help">{slotStatusText}</div>
          <div className="help">{vrmaStatus}</div>
        </div>

        {/* Preset Animations */}
        <div className="field">
          <div className="label">预设动作</div>
          <div className="help">来自 pixiv VRoid Project 的预设动作（点击播放）</div>
          <label className="switchRow" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={presetCarousel}
              onChange={(e) => {
                const v = Boolean(e.target.checked);
                setPresetCarousel(v);
                onToast(v ? "已开启：自动轮播预设动作" : "已关闭：自动轮播", { timeoutMs: 1800 });
              }}
            />
            <span className="switchLabel">自动轮播</span>
          </label>
          <div className="chipRow" style={{ marginTop: 8 }}>
            {VRMA_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`chip ${presetLoading === preset.id ? "loading" : ""}`}
                type="button"
                disabled={!!presetLoading}
                title={preset.description}
                onClick={() => void playPreset(preset)}
              >
                {presetLoading === preset.id ? "..." : preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="divider" />

        <div className="btnRow">
          <button
            className="btn btnPrimary"
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  const picked = await pickFileViaFileInput(".vrma");
                  if (!picked) return;

                  setLastVrmaBytes(picked.bytes);
                  setLastVrmaFileName(picked.fileName || "动作.vrma");
                  setVrmaStatus(`最近：${picked.fileName || "动作.vrma"}（加载中…）`);

                  // Suggest a name if empty
                  if (!normalizeVrmaName(vrmaSaveName)) {
                    setVrmaSaveName(normalizeVrmaName(stripExtension(picked.fileName || "动作")));
                  }

                  await loadVrmaBytes(picked.bytes);
                  setVrmaStatus(`最近：${picked.fileName || "动作.vrma"}（已加载）`);
                  onToast("已加载 VRMA（可设为 Idle/Walk）", { timeoutMs: 1800 });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  setVrmaStatus(`最近：${lastVrmaFileName || "—"}（失败）`);
                  onToast(`加载 VRMA 失败：${msg}`, { timeoutMs: 5200 });
                }
              })();
            }}
          >
            上传 VRMA
          </button>

          <button
            className="btn"
            type="button"
            disabled={!slots.hasLastLoaded}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "idle" } as any);
              onToast("已设为 Idle（自动切换）", { timeoutMs: 1600 });
            }}
          >
            设为 Idle
          </button>
          <button
            className="btn"
            type="button"
            disabled={!slots.hasLastLoaded}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "walk" } as any);
              onToast("已设为 Walk（自动切换）", { timeoutMs: 1600 });
            }}
          >
            设为 Walk
          </button>

          <button
            className="btn btnDanger"
            type="button"
            disabled={!slots.hasAction}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_ACTION" } as any);
              onToast("已停止动作", { timeoutMs: 1400 });
            }}
          >
            停止
          </button>

          <button className="btn" type="button" onClick={() => void refreshLibrary()} disabled={libLoading}>
            刷新动作库
          </button>
        </div>

        <div className="divider" />

        <div className="field">
          <div className="label">VRMA 速度</div>
          <input
            className="range"
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={motionUi.vrma.speed}
            onChange={(e) => {
              const v = clamp(Number(e.target.value), 0, 2);
              setMotionUi((s) => {
                const next = { ...s, vrma: { ...s.vrma, speed: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueVrmaConfig({ speed: v });
            }}
          />
          <div className="help">{motionUi.vrma.speed.toFixed(2)}x</div>
        </div>

        <label className="switchRow">
          <input
            type="checkbox"
            checked={motionUi.vrma.paused}
            onChange={(e) => {
              const v = Boolean(e.target.checked);
              setMotionUi((s) => {
                const next = { ...s, vrma: { ...s.vrma, paused: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueVrmaConfig({ paused: v });
            }}
          />
          <span className="switchLabel">暂停 VRMA</span>
        </label>

        <div className="divider" />

        <div className="field">
          <div className="label">保存到动作库</div>
          <div className="row">
            <input
              className="input"
              type="text"
              placeholder="动作名字"
              value={vrmaSaveName}
              onChange={(e) => setVrmaSaveName(e.target.value)}
            />
            <button
              className="btn btnPrimary"
              type="button"
              disabled={!lastVrmaBytes || !normalizeVrmaName(vrmaSaveName)}
              onClick={() => {
                void (async () => {
                  const bytes = lastVrmaBytes;
                  if (!bytes || !bytes.byteLength) {
                    onToast("请先上传一个 VRMA", { timeoutMs: 2200 });
                    return;
                  }
                  const name = normalizeVrmaName(vrmaSaveName);
                  if (!name) {
                    onToast("请输入动作名字", { timeoutMs: 1800 });
                    return;
                  }

                  try {
                    const existing = await vrmaGet(name);
                    if (existing) {
                      const ok = window.confirm(`动作库已存在「${name}」。要覆盖吗？`);
                      if (!ok) return;
                    }
                    const now = Date.now();
                    await vrmaPut({
                      name,
                      bytes: bytesToArrayBuffer(bytes),
                      createdAt: existing?.createdAt ?? now,
                      updatedAt: now
                    });
                    await refreshLibrary();
                    onToast(`已保存到动作库：${name}`, { timeoutMs: 2000 });
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    onToast(`保存失败：${msg}`, { timeoutMs: 5200 });
                  }
                })();
              }}
            >
              保存
            </button>
          </div>
          {lastVrmaFileName ? <div className="help">最近文件：{lastVrmaFileName}</div> : null}
        </div>

        {library.length === 0 ? (
          <div className="help">动作库为空。</div>
        ) : (
          <div className="memList" style={{ marginTop: 10 }}>
            {library.map((item) => (
              <div key={item.name} className="memCard">
                <div className="memTop">
                  <div className="memTitle">{item.name}</div>
                  <div className="memWhen">{new Date(item.updatedAt || item.createdAt).toLocaleString()}</div>
                </div>

                <div className="btnRow" style={{ marginTop: 10 }}>
                  <button
                    className="btn btnSm"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          const got = await vrmaGet(item.name);
                          if (!got) throw new Error("not found");
                          await loadVrmaBytes(new Uint8Array(got.bytes));
                          onToast(`已播放：${item.name}`, { timeoutMs: 1600 });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          onToast(`播放失败：${msg}`, { timeoutMs: 5200 });
                        }
                      })();
                    }}
                  >
                    播放
                  </button>

                  <button
                    className="btn btnSm"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          const got = await vrmaGet(item.name);
                          if (!got) throw new Error("not found");
                          await loadVrmaBytes(new Uint8Array(got.bytes));
                          sendPetControl(api, {
                            type: "PET_CONTROL",
                            ts: Date.now(),
                            action: "ASSIGN_VRMA_SLOT_FROM_LAST",
                            slot: "idle"
                          } as any);
                          onToast(`已设为 Idle：${item.name}`, { timeoutMs: 2000 });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          onToast(`设置失败：${msg}`, { timeoutMs: 5200 });
                        }
                      })();
                    }}
                  >
                    Idle
                  </button>

                  <button
                    className="btn btnSm"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          const got = await vrmaGet(item.name);
                          if (!got) throw new Error("not found");
                          await loadVrmaBytes(new Uint8Array(got.bytes));
                          sendPetControl(api, {
                            type: "PET_CONTROL",
                            ts: Date.now(),
                            action: "ASSIGN_VRMA_SLOT_FROM_LAST",
                            slot: "walk"
                          } as any);
                          onToast(`已设为 Walk：${item.name}`, { timeoutMs: 2000 });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          onToast(`设置失败：${msg}`, { timeoutMs: 5200 });
                        }
                      })();
                    }}
                  >
                    Walk
                  </button>

                  <button
                    className="btn btnSm"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        const next = normalizeVrmaName(window.prompt("新的名字：", item.name) ?? "");
                        if (!next) return;
                        if (next === item.name) return;
                        try {
                          const exists = await vrmaGet(next);
                          if (exists) {
                            const ok = window.confirm(`动作库已存在「${next}」。要覆盖吗？`);
                            if (!ok) return;
                          }
                          const got = await vrmaGet(item.name);
                          if (!got) throw new Error("not found");
                          await vrmaPut({ ...got, name: next, updatedAt: Date.now() });
                          await vrmaDelete(item.name);
                          await refreshLibrary();
                          onToast(`已重命名：${item.name} → ${next}`, { timeoutMs: 2000 });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          onToast(`重命名失败：${msg}`, { timeoutMs: 5200 });
                        }
                      })();
                    }}
                  >
                    重命名
                  </button>

                  <button
                    className="btn btnSm btnDanger"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        const ok = window.confirm(`删除动作「${item.name}」？`);
                        if (!ok) return;
                        try {
                          await vrmaDelete(item.name);
                          await refreshLibrary();
                          onToast("已删除", { timeoutMs: 1400 });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          onToast(`删除失败：${msg}`, { timeoutMs: 5200 });
                        }
                      })();
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Procedural motion fallback */}
      <div className="card">
        <div className="field">
          <div className="label">程序动作（兜底）</div>
          <div className="help">当没有 VRMA 动作时，用程序 Idle/Walk 维持“活着”。</div>
        </div>

        <div className="divider" />

        <label className="switchRow">
          <input
            type="checkbox"
            checked={motionUi.idle.enabled}
            onChange={(e) => {
              const v = Boolean(e.target.checked);
              setMotionUi((s) => {
                const next = { ...s, idle: { ...s.idle, enabled: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueIdleConfig({ enabled: v });
            }}
          />
          <span className="switchLabel">启用程序 Idle</span>
        </label>

        <div className="field" style={{ opacity: motionUi.idle.enabled ? 1 : 0.55 }}>
          <div className="label">Idle 强度</div>
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={motionUi.idle.strength}
            disabled={!motionUi.idle.enabled}
            onChange={(e) => {
              const v = clamp(Number(e.target.value), 0, 1);
              setMotionUi((s) => {
                const next = { ...s, idle: { ...s.idle, strength: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueIdleConfig({ strength: v });
            }}
          />
          <div className="help">{motionUi.idle.strength.toFixed(2)}</div>
        </div>

        <div className="field" style={{ opacity: motionUi.idle.enabled ? 1 : 0.55 }}>
          <div className="label">Idle 速度</div>
          <input
            className="range"
            type="range"
            min={0.2}
            max={2}
            step={0.01}
            value={motionUi.idle.speed}
            disabled={!motionUi.idle.enabled}
            onChange={(e) => {
              const v = clamp(Number(e.target.value), 0.2, 2);
              setMotionUi((s) => {
                const next = { ...s, idle: { ...s.idle, speed: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueIdleConfig({ speed: v });
            }}
          />
          <div className="help">{motionUi.idle.speed.toFixed(2)}x</div>
        </div>

        <div className="divider" />

        <label className="switchRow">
          <input
            type="checkbox"
            checked={motionUi.walk.enabled}
            onChange={(e) => {
              const v = Boolean(e.target.checked);
              setMotionUi((s) => {
                const next = { ...s, walk: { ...s.walk, enabled: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueWalkConfig({ enabled: v });
            }}
          />
          <span className="switchLabel">启用程序 Walk</span>
        </label>

        <div className="field" style={{ opacity: motionUi.walk.enabled ? 1 : 0.55 }}>
          <div className="label">Walk 速度</div>
          <input
            className="range"
            type="range"
            min={0.2}
            max={2}
            step={0.01}
            value={motionUi.walk.speed}
            disabled={!motionUi.walk.enabled}
            onChange={(e) => {
              const v = clamp(Number(e.target.value), 0.2, 2);
              setMotionUi((s) => {
                const next = { ...s, walk: { ...s.walk, speed: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueWalkConfig({ speed: v });
            }}
          />
          <div className="help">{motionUi.walk.speed.toFixed(2)}x</div>
        </div>

        <div className="field" style={{ opacity: motionUi.walk.enabled ? 1 : 0.55 }}>
          <div className="label">Stride（步幅）</div>
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={motionUi.walk.stride}
            disabled={!motionUi.walk.enabled}
            onChange={(e) => {
              const v = clamp(Number(e.target.value), 0, 1);
              setMotionUi((s) => {
                const next = { ...s, walk: { ...s.walk, stride: v } };
                saveMotionUiSettings(next);
                return next;
              });
              queueWalkConfig({ stride: v });
            }}
          />
          <div className="help">{motionUi.walk.stride.toFixed(2)}</div>
        </div>
      </div>
    </div>
  );
}
