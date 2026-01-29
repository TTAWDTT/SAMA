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

  const pendingVrmaCfg = useRef<any>({});
  const vrmaCfgTimer = useRef<number | null>(null);
  const pendingIdleCfg = useRef<any>({});
  const idleCfgTimer = useRef<number | null>(null);
  const pendingWalkCfg = useRef<any>({});
  const walkCfgTimer = useRef<number | null>(null);

  useEffect(() => saveQuietMode(quiet), [quiet]);

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

  async function playPreset(preset: VrmaPreset) {
    if (presetLoading) return;
    setPresetLoading(preset.id);
    try {
      const bytes = await loadPresetBytes(preset);
      await loadVrmaBytes(bytes);
      setVrmaStatus(`预设：${preset.name}（已加载）`);
      onToast(`已播放：${preset.name}`, { timeoutMs: 1600 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`加载预设动作失败：${msg}`, { timeoutMs: 5200 });
    } finally {
      setPresetLoading(null);
    }
  }

  function toggleDisplayMode() {
    const nextMode = displayMode.mode === "normal" ? "peek" : "normal";
    setDisplayMode((prev) => ({ ...prev, mode: nextMode }));
    sendPetControl(api, {
      type: "PET_CONTROL",
      ts: Date.now(),
      action: "SET_DISPLAY_MODE",
      config: { mode: nextMode }
    } as any);
    onToast(nextMode === "peek" ? "探出小脑袋模式" : "普通模式", { timeoutMs: 1600 });
  }

  const peekEdge: NonNullable<PetDisplayModeConfig["edge"]> = displayMode.edge ?? "right";
  const peekTiltDeg = Math.max(0, Math.min(60, Number(displayMode.tiltDeg ?? 15) || 15));

  const setPeekEdge = (edge: NonNullable<PetDisplayModeConfig["edge"]>) => {
    setDisplayMode((prev) => ({ ...prev, edge, mode: "peek" }));
    sendPetControl(api, {
      type: "PET_CONTROL",
      ts: Date.now(),
      action: "SET_DISPLAY_MODE",
      config: { edge, mode: "peek" }
    } as any);
  };

  const setPeekTilt = (tiltDeg: number) => {
    const v = Math.max(0, Math.min(60, Math.round(Number(tiltDeg) || 0)));
    setDisplayMode((prev) => ({ ...prev, tiltDeg: v, mode: "peek" }));
    sendPetControl(api, {
      type: "PET_CONTROL",
      ts: Date.now(),
      action: "SET_DISPLAY_MODE",
      config: { tiltDeg: v, mode: "peek" }
    } as any);
  };

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
              <div className="segRow">
                <div className="segLabel">靠边</div>
                <div className="seg">
                  {[
                    { key: "left", label: "左" },
                    { key: "right", label: "右" },
                    { key: "top", label: "上" },
                    { key: "bottom", label: "下" }
                  ].map((x) => (
                    <button
                      key={x.key}
                      className={`segBtn ${peekEdge === x.key ? "isActive" : ""}`}
                      type="button"
                      onClick={() => setPeekEdge(x.key as NonNullable<PetDisplayModeConfig["edge"]>)}
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row">
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={60}
                  step={1}
                  value={peekTiltDeg}
                  onChange={(e) => setPeekTilt(Number(e.target.value))}
                  aria-label="Peek tilt angle"
                />
                <div className="pill">{peekTiltDeg}°</div>
              </div>
              <div className="help">提示：探出模式会锁定在屏幕边缘；拖动角色可以沿边缘滑动。</div>
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
          <div className="chipRow">
            {(["NEUTRAL", "HAPPY", "SAD", "SHY", "TIRED"] as ActionCommand["expression"][]).map((x) => (
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
