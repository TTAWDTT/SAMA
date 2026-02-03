import { MOTION_PRESET_CYCLE, MOTION_PRESETS, type MotionPresetId } from "@sama/shared";
import type { ActionCommand, MotionPreset, PetDisplayModeConfig, PetStateMessage, PetWindowStateMessage } from "@sama/shared";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { StageDesktopApi } from "../api";
import { pickFileViaFileInput } from "../lib/filePicker";
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

const LS_PRESET_CAROUSEL = "sama.ui.vrma.presetCarousel.v1";
const LS_FRAME_ENABLED = "sama.ui.frame.enabled.v1";
const LS_FRAME_SIZE = "sama.ui.frame.size.v1";
const LS_FRAME_RADIUS = "sama.ui.frame.radius.v1";
const LS_FRAME_COLOR = "sama.ui.frame.color.v1";

function loadPresetCarouselEnabled() {
  try {
    const v = localStorage.getItem(LS_PRESET_CAROUSEL);
    if (v === null) return false;
    return v === "1";
  } catch {
    return false;
  }
}

function savePresetCarouselEnabled(v: boolean) {
  try {
    localStorage.setItem(LS_PRESET_CAROUSEL, v ? "1" : "0");
  } catch {}
}

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

// 表情中英文映射
const EXPRESSION_LABELS: Record<string, string> = {
  NEUTRAL: "平静",
  HAPPY: "开心",
  SAD: "难过",
  SHY: "害羞",
  TIRED: "疲惫",
  ANGRY: "生气",
  SURPRISED: "惊讶",
  THINKING: "思考",
  CONFUSED: "困惑",
  EXCITED: "兴奋"
};

type SlotsState = {
  hasIdle: boolean;
  hasWalk: boolean;
  hasAction: boolean;
  hasLastLoaded: boolean;
};

export function ActionsPanel(props: { api: StageDesktopApi | null; onToast: (msg: string, o?: any) => void }) {
  const { api, onToast } = props;

  const [presetCarousel, setPresetCarousel] = useState(loadPresetCarouselEnabled);

  // Expandable panels
  const [expandedPanel, setExpandedPanel] = useState<"expression" | "motion" | null>(null);

  // SAMA display frame settings
  const [frameEnabled, setFrameEnabled] = useState(loadFrameEnabled);
  const [frameSize, setFrameSize] = useState(loadFrameSize);
  const [frameRadius, setFrameRadius] = useState(loadFrameRadius);
  const [frameColor, setFrameColor] = useState(loadFrameColor);

  const [displayMode, setDisplayMode] = useState<PetDisplayModeConfig>({ mode: "normal" });

  const [slots, setSlots] = useState<SlotsState>({
    hasIdle: false,
    hasWalk: false,
    hasAction: false,
    hasLastLoaded: false
  });

  const [lastVrmaBytes, setLastVrmaBytes] = useState<Uint8Array | null>(null);
  const [lastVrmaFileName, setLastVrmaFileName] = useState<string>("");
  const [vrmaStatus, setVrmaStatus] = useState<string>("");
  const [vrmaSaveName, setVrmaSaveName] = useState<string>("");

  const [libLoading, setLibLoading] = useState(false);
  const [library, setLibrary] = useState<VrmaLibraryItem[]>([]);
  const [presetLoading, setPresetLoading] = useState<MotionPresetId | null>(null);
  const presetLoadingRef = useRef<MotionPresetId | null>(null);

  const pendingFrameCfg = useRef<any>({});
  const frameCfgTimer = useRef<number | null>(null);
  const presetCarouselTimer = useRef<number | null>(null);
  const presetCarouselIdx = useRef<number>(0);

  useEffect(() => savePresetCarouselEnabled(presetCarousel), [presetCarousel]);

  // Throttled frame config sender
  function queueFrameConfig(cfg: { enabled?: boolean; size?: number; radius?: number; color?: string; previewing?: boolean }) {
    pendingFrameCfg.current = { ...pendingFrameCfg.current, ...cfg };
    if (frameCfgTimer.current !== null) return;
    frameCfgTimer.current = window.setTimeout(() => {
      frameCfgTimer.current = null;
      const finalCfg = pendingFrameCfg.current;
      pendingFrameCfg.current = {};

      // Sanitize config to avoid IPC serialization errors (undefined/NaN values)
      const sanitizedCfg: Record<string, boolean | number | string> = {};
      if (typeof finalCfg.enabled === "boolean") sanitizedCfg.enabled = finalCfg.enabled;
      if (typeof finalCfg.size === "number" && Number.isFinite(finalCfg.size)) sanitizedCfg.size = finalCfg.size;
      if (typeof finalCfg.radius === "number" && Number.isFinite(finalCfg.radius)) sanitizedCfg.radius = finalCfg.radius;
      if (typeof finalCfg.color === "string" && finalCfg.color) sanitizedCfg.color = finalCfg.color;
      if (typeof finalCfg.previewing === "boolean") sanitizedCfg.previewing = finalCfg.previewing;

      sendPetControl(api, {
        type: "PET_CONTROL",
        ts: Date.now(),
        action: "SET_FRAME_CONFIG",
        config: sanitizedCfg
      } as any);
    }, 16);
  }

  function endFramePreview() {
    queueFrameConfig({ previewing: false });
  }

  function startFramePreview() {
    queueFrameConfig({ previewing: true });
  }

  useEffect(() => {
    saveFrameEnabled(frameEnabled);
    queueFrameConfig({ enabled: frameEnabled, size: frameSize, radius: frameRadius, color: frameColor });
  }, [frameEnabled]);

  useEffect(() => {
    saveFrameSize(frameSize);
    queueFrameConfig({ size: frameSize });
  }, [frameSize]);

  useEffect(() => {
    saveFrameRadius(frameRadius);
    queueFrameConfig({ radius: frameRadius });
  }, [frameRadius]);

  useEffect(() => {
    saveFrameColor(frameColor);
    queueFrameConfig({ color: frameColor });
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

  useEffect(() => {
    if (!api || typeof api.onPetWindowState !== "function") return;
    return api.onPetWindowState((s: PetWindowStateMessage) => {
      if (s?.displayMode) {
        setDisplayMode(s.displayMode);
      }
    });
  }, [api]);

  const doAction = (cmd: ActionCommand) => {
    const ok = sendManual(api, { type: "MANUAL_ACTION", ts: Date.now(), action: cmd.action, expression: cmd.expression });
    if (!ok) {
      try {
        api?.sendPetControl?.({ type: "PET_CONTROL", ts: Date.now(), action: "NOTIFY_ACTION", cmd } as any);
      } catch {}
    }
  };

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

  async function playBuiltInPreset(presetId: MotionPresetId, opts?: { silent?: boolean }) {
    if (presetLoadingRef.current) return;
    presetLoadingRef.current = presetId;
    setPresetLoading(presetId);
    try {
      const preset = MOTION_PRESETS.find((p) => p.id === presetId) as MotionPreset | undefined;
      if (!preset) throw new Error(`Unknown preset: ${presetId}`);

      const res = await sendPetControlWithResult(
        api,
        { type: "PET_CONTROL", ts: Date.now(), action: "PLAY_MOTION_PRESET", presetId } as any,
        { timeoutMs: preset.kind === "vrma_asset" ? 12_000 : 2_000 }
      );
      if (!res.ok) throw new Error(String(res.message ?? "load failed"));

      setVrmaStatus(`预设：${preset.name}`);
      if (!opts?.silent) onToast(`已播放：${preset.name}`, { timeoutMs: 1600 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts?.silent) onToast(`加载预设动作失败：${msg}`, { timeoutMs: 5200 });
    } finally {
      presetLoadingRef.current = null;
      setPresetLoading(null);
    }
  }

  useEffect(() => {
    if (!presetCarousel) {
      if (presetCarouselTimer.current !== null) {
        window.clearTimeout(presetCarouselTimer.current);
        presetCarouselTimer.current = null;
      }
      return;
    }
    if (!api) return;
    if (!MOTION_PRESET_CYCLE.length) return;

    let cancelled = false;
    const intervalMs = 10_000;

    const schedule = () => {
      if (cancelled) return;
      presetCarouselTimer.current = window.setTimeout(async () => {
        if (cancelled) return;
        const presetId =
          MOTION_PRESET_CYCLE[presetCarouselIdx.current % MOTION_PRESET_CYCLE.length] ?? MOTION_PRESET_CYCLE[0]!;
        presetCarouselIdx.current = (presetCarouselIdx.current + 1) % MOTION_PRESET_CYCLE.length;
        try {
          await playBuiltInPreset(presetId, { silent: true });
        } catch {}
        schedule();
      }, intervalMs);
    };

    presetCarouselTimer.current = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        const presetId =
          MOTION_PRESET_CYCLE[presetCarouselIdx.current % MOTION_PRESET_CYCLE.length] ?? MOTION_PRESET_CYCLE[0]!;
        presetCarouselIdx.current = (presetCarouselIdx.current + 1) % MOTION_PRESET_CYCLE.length;
        try {
          await playBuiltInPreset(presetId, { silent: true });
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

  useEffect(() => {
    void refreshLibrary();
  }, []);

  const handleScreenshot = async () => {
    const requestId = `screenshot-${Date.now()}`;
    try {
      const result = await sendPetControlWithResult(api, {
        type: "PET_CONTROL",
        ts: Date.now(),
        requestId,
        action: "TAKE_SCREENSHOT"
      } as any);
      if (result.ok && result.message) {
        const link = document.createElement("a");
        link.href = result.message;
        link.download = `SAMA-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")}.png`;
        link.click();
        onToast("截图已保存", { timeoutMs: 1600 });
      } else {
        onToast("截图失败", { timeoutMs: 2000 });
      }
    } catch {
      onToast("截图失败", { timeoutMs: 2000 });
    }
  };

  return (
    <div className="panel">
      <div className="panelHeader">
        <div className="panelTitle">动作与展示</div>
      </div>

      {/* 快捷操作区 */}
      <div className="card">
        <div className="btnRow">
          <button className="btn btnPrimary" type="button" onClick={() => doAction(buildCmd({ action: "APPROACH", durationMs: 1500 }))}>
            靠近
          </button>
          <button className="btn" type="button" onClick={() => doAction(buildCmd({ action: "RETREAT", durationMs: 1500 }))}>
            离远
          </button>
          <button
            className={`btn ${displayMode.mode === "peek" ? "btnPrimary" : ""}`}
            type="button"
            onClick={toggleDisplayMode}
          >
            {displayMode.mode === "peek" ? "普通" : "探头"}
          </button>
        </div>

        <div className="divider" />

        {/* 表情与动作 - 折叠展开按钮 */}
        <div className="expandBtnRow">
          <button
            className={`expandBtn ${expandedPanel === "expression" ? "active" : ""}`}
            type="button"
            onClick={() => setExpandedPanel(expandedPanel === "expression" ? null : "expression")}
          >
            😊 表情
          </button>
          <button
            className={`expandBtn ${expandedPanel === "motion" ? "active" : ""}`}
            type="button"
            onClick={() => setExpandedPanel(expandedPanel === "motion" ? null : "motion")}
          >
            💃 动作
          </button>
        </div>

        {/* 表情展开面板 */}
        <div className={`expandPanel ${expandedPanel === "expression" ? "open" : ""}`}>
          <div className="expandPanelInner">
            {(["NEUTRAL", "HAPPY", "SAD", "SHY", "TIRED", "ANGRY", "SURPRISED", "THINKING", "CONFUSED", "EXCITED"] as ActionCommand["expression"][]).map((x) => (
              <button
                key={x}
                className="expandItem"
                type="button"
                onClick={() => {
                  doAction(buildCmd({ action: "IDLE", expression: x, durationMs: 1200 }));
                  setExpandedPanel(null);
                }}
              >
                {EXPRESSION_LABELS[x] || x}
              </button>
            ))}
          </div>
        </div>

        {/* 动作展开面板 */}
        <div className={`expandPanel ${expandedPanel === "motion" ? "open" : ""}`}>
          <div className="expandPanelInner">
            {MOTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`expandItem ${presetLoading === preset.id ? "loading" : ""}`}
                type="button"
                disabled={!!presetLoading}
                onClick={() => {
                  void playBuiltInPreset(preset.id);
                  setExpandedPanel(null);
                }}
              >
                {presetLoading === preset.id ? "..." : preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="divider" />

        {/* 相机与截图 */}
        <div className="btnRow">
          {(["full", "half", "closeup"] as const).map((preset) => (
            <button
              key={preset}
              className="btn btnSm"
              type="button"
              onClick={() => {
                sendPetControl(api, {
                  type: "PET_CONTROL",
                  ts: Date.now(),
                  action: "SET_CAMERA_PRESET",
                  preset
                } as any);
              }}
            >
              {preset === "full" ? "全身" : preset === "half" ? "半身" : "特写"}
            </button>
          ))}
          <button className="btn btnSm" type="button" onClick={handleScreenshot}>
            📷
          </button>
        </div>
      </div>

      {/* 边框设置 */}
      <div className="card">
        <label className="switchRow">
          <input
            type="checkbox"
            checked={frameEnabled}
            onChange={(e) => setFrameEnabled(Boolean(e.target.checked))}
          />
          <span className="switchLabel">显示边框</span>
        </label>

        {frameEnabled && (
          <div className="frameControls">
            <div className="frameSliderRow">
              <span className="frameLabel">粗细</span>
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
              <span className="frameValue">{frameSize}</span>
            </div>
            <div className="frameSliderRow">
              <span className="frameLabel">圆角</span>
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
              <span className="frameValue">{frameRadius}</span>
            </div>
            <div className="colorRow">
              {["#d97757", "#6a9bcc", "#788c5d", "#8b5cf6", "#ec4899"].map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`colorDot ${frameColor === color ? "active" : ""}`}
                  style={{ background: color }}
                  onClick={() => setFrameColor(color)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* VRMA 动作库 */}
      <div className="card">
        <div className="field">
          <div className="label">动作库</div>
          <label className="switchRow">
            <input
              type="checkbox"
              checked={presetCarousel}
              onChange={(e) => setPresetCarousel(Boolean(e.target.checked))}
            />
            <span className="switchLabel">自动轮播</span>
          </label>
        </div>

        <div className="btnRow" style={{ marginTop: 12 }}>
          <button
            className="btn btnSm"
            type="button"
            onClick={() => {
              void (async () => {
                try {
                  const picked = await pickFileViaFileInput(".vrma");
                  if (!picked) return;
                  setLastVrmaBytes(picked.bytes);
                  setLastVrmaFileName(picked.fileName || "动作.vrma");
                  setVrmaStatus(`${picked.fileName || "动作.vrma"}`);
                  if (!normalizeVrmaName(vrmaSaveName)) {
                    setVrmaSaveName(normalizeVrmaName(stripExtension(picked.fileName || "动作")));
                  }
                  await loadVrmaBytes(picked.bytes);
                  onToast("已加载", { timeoutMs: 1200 });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  onToast(`失败：${msg}`, { timeoutMs: 3000 });
                }
              })();
            }}
          >
            上传
          </button>
          <button
            className="btn btnSm"
            type="button"
            disabled={!slots.hasLastLoaded}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "idle" } as any);
              onToast("设为 Idle", { timeoutMs: 1200 });
            }}
          >
            Idle
          </button>
          <button
            className="btn btnSm"
            type="button"
            disabled={!slots.hasLastLoaded}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "ASSIGN_VRMA_SLOT_FROM_LAST", slot: "walk" } as any);
              onToast("设为 Walk", { timeoutMs: 1200 });
            }}
          >
            Walk
          </button>
          <button
            className="btn btnSm"
            type="button"
            disabled={!slots.hasAction}
            onClick={() => {
              sendPetControl(api, { type: "PET_CONTROL", ts: Date.now(), action: "CLEAR_VRMA_ACTION" } as any);
            }}
          >
            停止
          </button>
        </div>

        {vrmaStatus && <div className="help" style={{ marginTop: 8 }}>{vrmaStatus}</div>}

        {/* 保存动作 */}
        {lastVrmaBytes && (
          <div className="row" style={{ marginTop: 12 }}>
            <input
              className="input"
              type="text"
              placeholder="名称"
              value={vrmaSaveName}
              onChange={(e) => setVrmaSaveName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn btnSm"
              type="button"
              disabled={!normalizeVrmaName(vrmaSaveName)}
              onClick={() => {
                void (async () => {
                  const bytes = lastVrmaBytes;
                  if (!bytes) return;
                  const name = normalizeVrmaName(vrmaSaveName);
                  if (!name) return;
                  try {
                    const existing = await vrmaGet(name);
                    if (existing && !window.confirm(`覆盖「${name}」？`)) return;
                    const now = Date.now();
                    await vrmaPut({
                      name,
                      bytes: bytesToArrayBuffer(bytes),
                      createdAt: existing?.createdAt ?? now,
                      updatedAt: now
                    });
                    await refreshLibrary();
                    onToast(`已保存：${name}`, { timeoutMs: 1600 });
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    onToast(`失败：${msg}`, { timeoutMs: 3000 });
                  }
                })();
              }}
            >
              保存
            </button>
          </div>
        )}

        {/* 动作库列表 */}
        {library.length > 0 && (
          <div className="libList">
            {library.map((item) => (
              <div key={item.name} className="libItem">
                <span className="libName">{item.name}</span>
                <div className="libActions">
                  <button
                    className="libBtn"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          const got = await vrmaGet(item.name);
                          if (!got) return;
                          await loadVrmaBytes(new Uint8Array(got.bytes));
                        } catch {}
                      })();
                    }}
                  >
                    ▶
                  </button>
                  <button
                    className="libBtn danger"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        if (!window.confirm(`删除「${item.name}」？`)) return;
                        await vrmaDelete(item.name);
                        await refreshLibrary();
                      })();
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
