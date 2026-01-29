import type { ActionCommand } from "@sama/shared";
import { DEFAULT_IDLE_CONFIG } from "./idle";
import type { IdleConfig } from "./idle";
import type { ModelTransform, PetScene, VrmAnimationConfig } from "./scene";
import { DEFAULT_WALK_CONFIG } from "./walk";
import type { WalkConfig } from "./walk";

type StoredSettingsV1 = {
  version: 1;
  panelOpen?: boolean;
  modelTransform?: Partial<ModelTransform>;
  idleConfig?: Partial<IdleConfig>;
  walkConfig?: Partial<WalkConfig>;
  vrmAnimationConfig?: Partial<VrmAnimationConfig>;
  /** UI-only metadata: which named library item user assigned to slots. */
  vrmaSlotNames?: { idle?: string; walk?: string };
  debugHudVisible?: boolean;
};

const STORAGE_KEY = "sama.pet.controls.v1";

type VrmaLibraryItem = {
  name: string;
  bytes: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
};

const VRMA_DB_NAME = "sama.vrma.library";
const VRMA_DB_VERSION = 1;
const VRMA_STORE = "vrma";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function stripExtension(name: string) {
  return name.replace(/\.[^/.]+$/, "");
}

function normalizeVrmaName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function openVrmaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VRMA_DB_NAME, VRMA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VRMA_STORE)) {
        db.createObjectStore(VRMA_STORE, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

async function vrmaList(): Promise<VrmaLibraryItem[]> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as VrmaLibraryItem[]) ?? [];
      items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB getAll failed"));
  });
}

async function vrmaGet(name: string): Promise<VrmaLibraryItem | null> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.get(name);
    req.onsuccess = () => resolve((req.result as VrmaLibraryItem) ?? null);
    req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
  });
}

async function vrmaPut(item: VrmaLibraryItem): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB put failed"));
  });
}

async function vrmaDelete(name: string): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.delete(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB delete failed"));
  });
}

function loadSettings(): StoredSettingsV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSettingsV1;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSettings(s: StoredSettingsV1) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore (private mode / quota)
  }
}

function createRangeRow(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const row = document.createElement("div");
  row.className = "panelRow";

  const label = document.createElement("div");
  label.className = "panelRowLabel";
  label.textContent = opts.label;

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);

  const value = document.createElement("div");
  value.className = "panelRowValue";
  const fmt = opts.format ?? ((v: number) => String(v));

  const updateValue = () => {
    const v = Number(input.value);
    value.textContent = fmt(v);
  };

  updateValue();
  input.addEventListener("input", () => {
    const v = Number(input.value);
    updateValue();
    opts.onInput(v);
  });

  row.append(label, input, value);
  return { row, input, value, updateValue };
}

function createDetails(title: string, initialOpen: boolean) {
  const details = document.createElement("details");
  details.className = "details";
  details.open = Boolean(initialOpen);

  const summary = document.createElement("summary");
  summary.textContent = title;

  const body = document.createElement("div");
  body.className = "detailsBody";

  details.append(summary, body);
  return { details, summary, body };
}

function chip(text: string, strong = false) {
  const el = document.createElement("div");
  el.className = `chip${strong ? " chipStrong" : ""}`;
  el.textContent = text;
  return el;
}

function hasVrmLoaded(scene: PetScene) {
  // `getIdleConfig()` and `getWalkConfig()` return null when VRM isn't ready.
  return !!scene.getIdleConfig() || !!scene.getWalkConfig();
}

async function pickBytesViaFileInput(accept: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(new Uint8Array());
            return;
          }
          const buf = await file.arrayBuffer();
          resolve(new Uint8Array(buf));
        } catch {
          resolve(new Uint8Array());
        } finally {
          input.remove();
        }
      },
      { once: true }
    );

    input.click();
  });
}

async function pickFileViaFileInput(accept: string): Promise<{ bytes: Uint8Array; name: string | null }> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve({ bytes: new Uint8Array(), name: null });
            return;
          }
          const buf = await file.arrayBuffer();
          resolve({ bytes: new Uint8Array(buf), name: file.name ?? null });
        } catch {
          resolve({ bytes: new Uint8Array(), name: null });
        } finally {
          input.remove();
        }
      },
      { once: true }
    );

    input.click();
  });
}

async function pickVrmBytes(opts: { onInfo?: (msg: string) => void }): Promise<Uint8Array> {
  const api: any = (window as any).stageDesktop;
  if (api && typeof api.pickVrmBytes === "function") return api.pickVrmBytes();
  opts.onInfo?.("未检测到 preload API，使用浏览器文件选择器加载 VRM。");
  return pickBytesViaFileInput(".vrm");
}

function makeTestAction(action: ActionCommand["action"], durationMs: number): ActionCommand {
  return {
    type: "ACTION_COMMAND",
    ts: Date.now(),
    action,
    expression: "NEUTRAL",
    bubble: null,
    durationMs
  };
}

export function attachPetControls(opts: { scene: PetScene; root: HTMLDivElement; onInfo?: (msg: string) => void }) {
  const stored: StoredSettingsV1 = loadSettings() ?? { version: 1 };
  const stageApi: any = (window as any).stageDesktop;
  let vrmLockedUi = false;

  if (stored.modelTransform) opts.scene.setModelTransform(stored.modelTransform);
  if (stored.idleConfig) opts.scene.setIdleConfig(stored.idleConfig);
  if (stored.walkConfig) opts.scene.setWalkConfig(stored.walkConfig);
  if (stored.vrmAnimationConfig) opts.scene.setVrmAnimationConfig(stored.vrmAnimationConfig);

  const hudEl = document.getElementById("hud");
  const hud = hudEl instanceof HTMLDivElement ? hudEl : null;
  if (hud) {
    const visible = Boolean(stored.debugHudVisible);
    hud.style.display = visible ? "block" : "none";
  }

  const wrapper = document.createElement("div");
  wrapper.className = "panel";

  const header = document.createElement("div");
  header.className = "panelHeader";

  const title = document.createElement("div");
  title.className = "panelTitle";
  title.textContent = "SAMA 控制台";

  const toggle = document.createElement("button");
  toggle.className = "panelToggle";
  toggle.type = "button";

  const body = document.createElement("div");
  body.className = "panelBody";

  let panelOpen = stored.panelOpen !== undefined ? Boolean(stored.panelOpen) : true;
  const setPanelOpen = (open: boolean) => {
    panelOpen = open;
    body.style.display = panelOpen ? "grid" : "none";
    toggle.textContent = panelOpen ? "收起" : "展开";
    stored.panelOpen = panelOpen;
    saveSettings(stored);
  };

  toggle.addEventListener("click", () => setPanelOpen(!panelOpen));

  header.append(title, toggle);
  wrapper.append(header, body);
  opts.root.appendChild(wrapper);

  // Status chips (auto refresh)
  const statusRow = document.createElement("div");
  statusRow.className = "dockStatus";
  const chipModel = chip("模型：—", true);
  const chipLLM = chip("LLM：—");
  const chipMotion = chip("状态：—", true);
  const chipClickThrough = chip("穿透：—");
  const chipWindow = chip("窗口：—");
  const chipVrma = chip("VRMA：—");
  statusRow.append(chipModel, chipLLM, chipMotion, chipClickThrough, chipWindow, chipVrma);
  body.appendChild(statusRow);

  // Quick actions
  const dock = document.createElement("div");
  dock.className = "dockGrid";

  const btnLoadVrm = document.createElement("button");
  btnLoadVrm.className = "dockBtn dockBtnPrimary";
  btnLoadVrm.type = "button";
  btnLoadVrm.textContent = "加载 VRM…";

  const btnLoadVrma = document.createElement("button");
  btnLoadVrma.className = "dockBtn dockBtnPrimary";
  btnLoadVrma.type = "button";
  btnLoadVrma.textContent = "加载 VRMA…";

  const btnSetIdle = document.createElement("button");
  btnSetIdle.className = "dockBtn";
  btnSetIdle.type = "button";
  btnSetIdle.textContent = "设为 Idle";

  const btnSetWalk = document.createElement("button");
  btnSetWalk.className = "dockBtn";
  btnSetWalk.type = "button";
  btnSetWalk.textContent = "设为 Walk";

  const btnStopAction = document.createElement("button");
  btnStopAction.className = "dockBtn";
  btnStopAction.type = "button";
  btnStopAction.textContent = "停止动作";

  const btnCenter = document.createElement("button");
  btnCenter.className = "dockBtn";
  btnCenter.type = "button";
  btnCenter.textContent = "角色居中";

  const btnRefit = document.createElement("button");
  btnRefit.className = "dockBtn";
  btnRefit.type = "button";
  btnRefit.textContent = "重置视角";

  const btnTestBubble = document.createElement("button");
  btnTestBubble.className = "dockBtn";
  btnTestBubble.type = "button";
  btnTestBubble.textContent = "测试气泡";

  const btnTestWalk = document.createElement("button");
  btnTestWalk.className = "dockBtn dockSpan2";
  btnTestWalk.type = "button";
  btnTestWalk.textContent = "测试：走两步（不移动窗口）";

  dock.append(
    btnLoadVrm,
    btnLoadVrma,
    btnSetIdle,
    btnSetWalk,
    btnStopAction,
    btnCenter,
    btnRefit,
    btnTestBubble,
    btnTestWalk
  );
  body.appendChild(dock);

  const vrmaHelp = document.createElement("div");
  vrmaHelp.style.color = "rgba(15, 23, 42, 0.62)";
  vrmaHelp.style.fontSize = "12px";
  vrmaHelp.textContent =
    "提示：加载 VRMA 后，点「设为 Idle/Walk」即可自动切换。你也可以把 VRMA 保存到“动作库”里并用自定义名字管理。";
  body.appendChild(vrmaHelp);

  // Sync VRM lock state from main (if supported by preload).
  void (async () => {
    try {
      const info = stageApi && typeof stageApi.getAppInfo === "function" ? await stageApi.getAppInfo() : null;
      vrmLockedUi = Boolean(info?.vrmLocked);
      if (vrmLockedUi) {
        btnLoadVrm.disabled = true;
        btnLoadVrm.textContent = "VRM 已固定";
      }
    } catch {
      // ignore
    }
  })();

  btnTestBubble.addEventListener("click", () => {
    void withBusy(btnTestBubble, async () => {
      const api: any = (window as any).stageDesktop;
      if (!api || typeof api.chatInvoke !== "function") {
        opts.onInfo?.("preload API 不可用：无法发起测试对话（请从托盘打开 Controls）。");
        return;
      }

      opts.onInfo?.("发送测试消息…（回复会显示在角色旁气泡）");
      await api.chatInvoke("测试气泡：请回复一句话，用于验证气泡显示");
      opts.onInfo?.("测试完成：如果还看不到气泡，请检查是否是浏览器打开/或窗口被遮挡。");
    });
  });

  // Window size controls (pet display window)
  const windowDetails = createDetails("窗口大小（展示）", true);
  body.appendChild(windowDetails.details);

  const windowHint = document.createElement("div");
  windowHint.style.color = "rgba(15, 23, 42, 0.62)";
  windowHint.style.fontSize = "12px";
  windowHint.textContent =
    "可通过拖拽桌宠窗口边缘缩放；也可以在这里精确设置宽高（即使穿透开启也可调）。窗口大小会自动记住。";
  windowDetails.body.appendChild(windowHint);

  const windowSizeLine = document.createElement("div");
  windowSizeLine.style.color = "rgba(15, 23, 42, 0.78)";
  windowSizeLine.style.fontSize = "12px";
  windowSizeLine.textContent = "当前：—";
  windowDetails.body.appendChild(windowSizeLine);

  const presetRow = document.createElement("div");
  presetRow.className = "panelButtons";
  const presetSmall = document.createElement("button");
  presetSmall.className = "panelBtn";
  presetSmall.type = "button";
  presetSmall.textContent = "小 (320×480)";
  const presetMid = document.createElement("button");
  presetMid.className = "panelBtn";
  presetMid.type = "button";
  presetMid.textContent = "中 (420×640)";
  const presetLarge = document.createElement("button");
  presetLarge.className = "panelBtn";
  presetLarge.type = "button";
  presetLarge.textContent = "大 (520×760)";
  presetRow.append(presetSmall, presetMid, presetLarge);
  windowDetails.body.appendChild(presetRow);

  const customRow = document.createElement("div");
  customRow.style.display = "grid";
  customRow.style.gridTemplateColumns = "1fr 1fr auto";
  customRow.style.gap = "8px";
  customRow.style.alignItems = "center";

  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.min = "260";
  widthInput.max = "2000";
  widthInput.step = "10";
  widthInput.placeholder = "宽";
  widthInput.value = "420";
  widthInput.style.width = "100%";
  widthInput.style.boxSizing = "border-box";
  widthInput.style.border = "1px solid rgba(15, 23, 42, 0.12)";
  widthInput.style.background = "rgba(255, 255, 255, 0.92)";
  widthInput.style.borderRadius = "10px";
  widthInput.style.padding = "8px 10px";
  widthInput.style.color = "rgba(15, 23, 42, 0.92)";
  widthInput.style.outline = "none";
  widthInput.style.font = "inherit";

  const heightInput = document.createElement("input");
  heightInput.type = "number";
  heightInput.min = "360";
  heightInput.max = "2000";
  heightInput.step = "10";
  heightInput.placeholder = "高";
  heightInput.value = "640";
  heightInput.style.width = "100%";
  heightInput.style.boxSizing = "border-box";
  heightInput.style.border = "1px solid rgba(15, 23, 42, 0.12)";
  heightInput.style.background = "rgba(255, 255, 255, 0.92)";
  heightInput.style.borderRadius = "10px";
  heightInput.style.padding = "8px 10px";
  heightInput.style.color = "rgba(15, 23, 42, 0.92)";
  heightInput.style.outline = "none";
  heightInput.style.font = "inherit";

  const applySizeBtn = document.createElement("button");
  applySizeBtn.className = "panelBtn";
  applySizeBtn.type = "button";
  applySizeBtn.textContent = "应用";

  customRow.append(widthInput, heightInput, applySizeBtn);
  windowDetails.body.appendChild(customRow);

  const lockRatioCheck = document.createElement("label");
  lockRatioCheck.className = "panelCheck";
  const lockRatioInput = document.createElement("input");
  lockRatioInput.type = "checkbox";
  lockRatioInput.checked = true;
  lockRatioCheck.append(lockRatioInput, document.createTextNode("锁定比例（改宽自动算高）"));
  windowDetails.body.appendChild(lockRatioCheck);

  const nudgeRow = document.createElement("div");
  nudgeRow.className = "panelButtons";
  const btnSmaller = document.createElement("button");
  btnSmaller.className = "panelBtn";
  btnSmaller.type = "button";
  btnSmaller.textContent = "缩小 10%";
  const btnBigger = document.createElement("button");
  btnBigger.className = "panelBtn";
  btnBigger.type = "button";
  btnBigger.textContent = "放大 10%";
  const btnReset = document.createElement("button");
  btnReset.className = "panelBtn";
  btnReset.type = "button";
  btnReset.textContent = "恢复默认 (420×640)";
  nudgeRow.append(btnSmaller, btnBigger, btnReset);
  windowDetails.body.appendChild(nudgeRow);

  let petWindowSize: { width: number; height: number } | null = null;
  let aspect = 420 / 640;
  let syncingSize = false;

  const sendWindowSize = (size: { width?: number; height?: number }) => {
    if (!stageApi || typeof stageApi.sendPetControl !== "function") {
      opts.onInfo?.("preload API 不可用：无法设置窗口大小。");
      return;
    }
    stageApi.sendPetControl({ type: "PET_CONTROL", ts: Date.now(), action: "SET_PET_WINDOW_SIZE", size });
  };

  const syncWindowUiFromState = () => {
    if (!petWindowSize) return;
    windowSizeLine.textContent = `当前：${petWindowSize.width} × ${petWindowSize.height}`;
    chipWindow.textContent = `窗口：${petWindowSize.width}×${petWindowSize.height}`;
    if (lockRatioInput.checked && petWindowSize.height > 0) {
      aspect = petWindowSize.width / petWindowSize.height;
    }
    if (document.activeElement !== widthInput) widthInput.value = String(petWindowSize.width);
    if (document.activeElement !== heightInput) heightInput.value = String(petWindowSize.height);
  };

  const unsubPetWindowState =
    stageApi && typeof stageApi.onPetWindowState === "function"
      ? stageApi.onPetWindowState((s: any) => {
          const w = Number(s?.size?.width ?? 0);
          const h = Number(s?.size?.height ?? 0);
          if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
          petWindowSize = { width: Math.round(w), height: Math.round(h) };
          syncWindowUiFromState();
        })
      : null;

  presetSmall.addEventListener("click", () => {
    sendWindowSize({ width: 320, height: 480 });
    opts.onInfo?.("已设置窗口大小：320×480");
  });
  presetMid.addEventListener("click", () => {
    sendWindowSize({ width: 420, height: 640 });
    opts.onInfo?.("已设置窗口大小：420×640");
  });
  presetLarge.addEventListener("click", () => {
    sendWindowSize({ width: 520, height: 760 });
    opts.onInfo?.("已设置窗口大小：520×760");
  });

  const applySize = () => {
    const w = Math.round(Number(widthInput.value));
    const h = Math.round(Number(heightInput.value));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      opts.onInfo?.("窗口大小不合法，请输入有效的宽/高。");
      return;
    }
    sendWindowSize({ width: w, height: h });
    opts.onInfo?.(`已设置窗口大小：${w}×${h}`);
  };

  applySizeBtn.addEventListener("click", () => applySize());
  widthInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySize();
  });
  heightInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySize();
  });

  widthInput.addEventListener("input", () => {
    if (!lockRatioInput.checked) return;
    if (syncingSize) return;
    const w = Number(widthInput.value);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(aspect) || aspect <= 0) return;
    syncingSize = true;
    heightInput.value = String(Math.max(1, Math.round(w / aspect)));
    syncingSize = false;
  });

  heightInput.addEventListener("input", () => {
    if (!lockRatioInput.checked) return;
    if (syncingSize) return;
    const h = Number(heightInput.value);
    if (!Number.isFinite(h) || h <= 0 || !Number.isFinite(aspect) || aspect <= 0) return;
    syncingSize = true;
    widthInput.value = String(Math.max(1, Math.round(h * aspect)));
    syncingSize = false;
  });

  const getCurrentSizeForNudge = () => {
    if (petWindowSize) return petWindowSize;
    const w = Math.round(Number(widthInput.value));
    const h = Math.round(Number(heightInput.value));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    return { width: 420, height: 640 };
  };

  btnSmaller.addEventListener("click", () => {
    const cur = getCurrentSizeForNudge();
    const nextW = Math.max(1, Math.round(cur.width * 0.9));
    const nextH = Math.max(1, Math.round(cur.height * 0.9));
    sendWindowSize({ width: nextW, height: nextH });
    opts.onInfo?.(`已设置窗口大小：${nextW}×${nextH}`);
  });

  btnBigger.addEventListener("click", () => {
    const cur = getCurrentSizeForNudge();
    const nextW = Math.max(1, Math.round(cur.width * 1.1));
    const nextH = Math.max(1, Math.round(cur.height * 1.1));
    sendWindowSize({ width: nextW, height: nextH });
    opts.onInfo?.(`已设置窗口大小：${nextW}×${nextH}`);
  });

  btnReset.addEventListener("click", () => {
    sendWindowSize({ width: 420, height: 640 });
    opts.onInfo?.("已设置窗口大小：420×640");
  });

  // VRMA library (custom named actions)
  let lastVrmaBytes: Uint8Array | null = null;
  let lastVrmaSuggestedName: string | null = null;

  const libraryDetails = createDetails("动作库（自定义名字）", true);
  body.appendChild(libraryDetails.details);

  const libHint = document.createElement("div");
  libHint.style.color = "rgba(15, 23, 42, 0.62)";
  libHint.style.fontSize = "12px";
  libHint.textContent = "流程：先「加载 VRMA…」→ 在这里输入名字 → 点「保存」→ 以后可按名字一键播放/切换。";
  libraryDetails.body.appendChild(libHint);

  const nameRow = document.createElement("div");
  nameRow.style.display = "grid";
  nameRow.style.gridTemplateColumns = "1fr auto";
  nameRow.style.gap = "8px";
  nameRow.style.alignItems = "center";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "动作名字（例如：dance / wave / sit / idle_v2）";
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.style.width = "100%";
  nameInput.style.boxSizing = "border-box";
  nameInput.style.border = "1px solid rgba(15, 23, 42, 0.12)";
  nameInput.style.background = "rgba(255, 255, 255, 0.92)";
  nameInput.style.borderRadius = "10px";
  nameInput.style.padding = "8px 10px";
  nameInput.style.color = "rgba(15, 23, 42, 0.92)";
  nameInput.style.outline = "none";
  nameInput.style.font = "inherit";

  const btnSaveToLib = document.createElement("button");
  btnSaveToLib.className = "panelBtn";
  btnSaveToLib.type = "button";
  btnSaveToLib.textContent = "保存";

  nameRow.append(nameInput, btnSaveToLib);
  libraryDetails.body.appendChild(nameRow);

  const libButtons = document.createElement("div");
  libButtons.className = "panelButtons";

  const btnImportToLib = document.createElement("button");
  btnImportToLib.className = "panelBtn";
  btnImportToLib.type = "button";
  btnImportToLib.textContent = "导入 VRMA 到库…";

  const btnRefreshLib = document.createElement("button");
  btnRefreshLib.className = "panelBtn";
  btnRefreshLib.type = "button";
  btnRefreshLib.textContent = "刷新列表";

  libButtons.append(btnImportToLib, btnRefreshLib);
  libraryDetails.body.appendChild(libButtons);

  const libList = document.createElement("div");
  libList.style.display = "grid";
  libList.style.gap = "8px";
  libraryDetails.body.appendChild(libList);

  function formatErr(err: unknown) {
    if (err instanceof Error) return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  async function withBusy(btn: HTMLButtonElement, run: () => Promise<void>) {
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      await run();
    } catch (err) {
      opts.onInfo?.(`操作失败：${formatErr(err)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = prev ?? "";
    }
  }

  function formatBytes(n: number) {
    const kb = n / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
  }

  function shortName(name: string, max = 18) {
    const s = String(name ?? "");
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1))}…`;
  }

  async function refreshLibraryList() {
    libList.replaceChildren();
    let items: VrmaLibraryItem[] = [];
    try {
      items = await vrmaList();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const warn = document.createElement("div");
      warn.style.color = "rgba(255, 160, 160, 0.92)";
      warn.style.fontSize = "12px";
      warn.textContent = `动作库读取失败：${msg}`;
      libList.appendChild(warn);
      return;
    }

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "rgba(15, 23, 42, 0.56)";
      empty.style.fontSize = "12px";
      empty.textContent = "动作库为空。";
      libList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const card = document.createElement("div");
      card.style.border = "1px solid rgba(15, 23, 42, 0.12)";
      card.style.borderRadius = "12px";
      card.style.background = "rgba(255, 255, 255, 0.72)";
      card.style.padding = "10px";

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "baseline";
      header.style.justifyContent = "space-between";
      header.style.gap = "10px";

      const nameEl = document.createElement("div");
      nameEl.style.fontWeight = "800";
      nameEl.style.letterSpacing = "0.2px";
      nameEl.textContent = item.name;

      const meta = document.createElement("div");
      meta.style.fontSize = "12px";
      meta.style.color = "rgba(15, 23, 42, 0.56)";
      meta.textContent = formatBytes(item.bytes.byteLength);

      header.append(nameEl, meta);
      card.appendChild(header);

      const buttons = document.createElement("div");
      buttons.className = "panelButtons";
      buttons.style.marginTop = "8px";

      const playBtn = document.createElement("button");
      playBtn.className = "panelBtn";
      playBtn.type = "button";
      playBtn.textContent = "播放";

      const setIdleBtn = document.createElement("button");
      setIdleBtn.className = "panelBtn";
      setIdleBtn.type = "button";
      setIdleBtn.textContent = "设为 Idle";

      const setWalkBtn = document.createElement("button");
      setWalkBtn.className = "panelBtn";
      setWalkBtn.type = "button";
      setWalkBtn.textContent = "设为 Walk";

      const renameBtn = document.createElement("button");
      renameBtn.className = "panelBtn";
      renameBtn.type = "button";
      renameBtn.textContent = "重命名";

      const delBtn = document.createElement("button");
      delBtn.className = "panelBtn";
      delBtn.type = "button";
      delBtn.textContent = "删除";

      playBtn.addEventListener("click", () => {
        void withBusy(playBtn, async () => {
          const got = await vrmaGet(item.name);
          if (!got) {
            opts.onInfo?.("动作不存在（可能已被删除），请刷新列表。");
            return;
          }
          const bytes = new Uint8Array(got.bytes);
          lastVrmaBytes = bytes;
          lastVrmaSuggestedName = got.name;
          const ok = await opts.scene.loadVrmAnimationBytes(bytes);
          opts.onInfo?.(ok ? `正在播放：${shortName(got.name)}` : `动作不可用：${shortName(got.name)}`);
        });
      });

      const assignSlot = (slot: "idle" | "walk") => {
        const btn = slot === "idle" ? setIdleBtn : setWalkBtn;
        void withBusy(btn, async () => {
          const got = await vrmaGet(item.name);
          if (!got) {
            opts.onInfo?.("动作不存在（可能已被删除），请刷新列表。");
            return;
          }
          const bytes = new Uint8Array(got.bytes);
          lastVrmaBytes = bytes;
          lastVrmaSuggestedName = got.name;
          const ok = await opts.scene.loadVrmAnimationBytes(bytes);
          if (!ok) {
            opts.onInfo?.(`动作不可用：${shortName(got.name)}`);
            return;
          }
          opts.scene.setVrmAnimationSlotFromLast(slot);
          stored.vrmaSlotNames = { ...(stored.vrmaSlotNames ?? {}), [slot]: got.name };
          saveSettings(stored);
          opts.onInfo?.(`已设为 ${slot.toUpperCase()}：${shortName(got.name)}`);
        });
      };

      setIdleBtn.addEventListener("click", () => assignSlot("idle"));
      setWalkBtn.addEventListener("click", () => assignSlot("walk"));

      renameBtn.addEventListener("click", () => {
        void withBusy(renameBtn, async () => {
          const next = normalizeVrmaName(window.prompt("新的动作名字：", item.name) ?? "");
          if (!next) return;
          if (next === item.name) return;
          const exists = await vrmaGet(next);
          if (exists) {
            const ok = window.confirm(`动作库里已经有同名「${next}」。要覆盖吗？`);
            if (!ok) return;
          }
          const got = await vrmaGet(item.name);
          if (!got) {
            opts.onInfo?.("动作不存在（可能已被删除），请刷新列表。");
            return;
          }
          await vrmaPut({ ...got, name: next, updatedAt: Date.now() });
          await vrmaDelete(item.name);

          // Keep UI metadata in sync.
          if (stored.vrmaSlotNames?.idle === item.name) stored.vrmaSlotNames.idle = next;
          if (stored.vrmaSlotNames?.walk === item.name) stored.vrmaSlotNames.walk = next;
          saveSettings(stored);
          await refreshLibraryList();
          opts.onInfo?.(`已重命名为：${shortName(next)}`);
        });
      });

      delBtn.addEventListener("click", () => {
        void withBusy(delBtn, async () => {
          const ok = window.confirm(`确定删除动作「${item.name}」吗？`);
          if (!ok) return;
          await vrmaDelete(item.name);
          if (stored.vrmaSlotNames?.idle === item.name) stored.vrmaSlotNames.idle = undefined;
          if (stored.vrmaSlotNames?.walk === item.name) stored.vrmaSlotNames.walk = undefined;
          saveSettings(stored);
          await refreshLibraryList();
          opts.onInfo?.(`已删除：${shortName(item.name)}`);
        });
      });

      buttons.append(playBtn, setIdleBtn, setWalkBtn, renameBtn, delBtn);
      card.appendChild(buttons);
      libList.appendChild(card);
    }
  }

  btnLoadVrm.addEventListener("click", () => {
    if (vrmLockedUi) {
      opts.onInfo?.("模型已锁定：无法切换 VRM。");
      return;
    }
    void withBusy(btnLoadVrm, async () => {
      opts.onInfo?.("选择 VRM…");
      const bytes = await pickVrmBytes({ onInfo: opts.onInfo });
      if (!bytes.byteLength) {
        opts.onInfo?.("未选择文件（保持当前模型）");
        return;
      }
      await opts.scene.loadVrmBytes(bytes);
      opts.scene.refitCamera();
      opts.onInfo?.("已加载 VRM ✅");
    });
  });

  btnLoadVrma.addEventListener("click", () => {
    void withBusy(btnLoadVrma, async () => {
      opts.onInfo?.("选择 VRMA（.vrma）…");
      const picked = await pickFileViaFileInput(".vrma");
      const bytes = picked.bytes;
      if (!bytes.byteLength) {
        opts.onInfo?.("未选择动作文件（保持当前动作）");
        return;
      }
      lastVrmaBytes = bytes.byteLength ? bytes : null;
      lastVrmaSuggestedName = picked.name ? stripExtension(picked.name) : null;
      const ok = await opts.scene.loadVrmAnimationBytes(bytes);
      opts.onInfo?.(ok ? "动作加载成功 ✅（可设为 Idle/Walk 槽位）" : "动作文件不兼容/解析失败（请换一个 .vrma）");
    });
  });

  btnSetIdle.addEventListener("click", () => {
    const ok = opts.scene.setVrmAnimationSlotFromLast("idle");
    if (ok && lastVrmaSuggestedName) {
      stored.vrmaSlotNames = { ...(stored.vrmaSlotNames ?? {}), idle: lastVrmaSuggestedName };
      saveSettings(stored);
    }
    opts.onInfo?.(ok ? "已将最近加载的 VRMA 设为 Idle（自动切换）" : "请先加载一个 .vrma 动作文件");
  });

  btnSetWalk.addEventListener("click", () => {
    const ok = opts.scene.setVrmAnimationSlotFromLast("walk");
    if (ok && lastVrmaSuggestedName) {
      stored.vrmaSlotNames = { ...(stored.vrmaSlotNames ?? {}), walk: lastVrmaSuggestedName };
      saveSettings(stored);
    }
    opts.onInfo?.(ok ? "已将最近加载的 VRMA 设为 Walk（自动切换）" : "请先加载一个 .vrma 动作文件");
  });

  btnStopAction.addEventListener("click", () => {
    opts.scene.clearVrmAnimation();
    opts.onInfo?.("已停止动作（回到 Idle/Walk 自动切换）");
  });

  btnCenter.addEventListener("click", () => {
    const cur = opts.scene.getModelTransform();
    opts.scene.setModelTransform({ offsetX: 0, offsetY: 0, offsetZ: 0, yawDeg: cur.yawDeg, scale: cur.scale });
    opts.scene.refitCamera();
    stored.modelTransform = { ...(stored.modelTransform ?? {}), offsetX: 0, offsetY: 0, offsetZ: 0 };
    saveSettings(stored);
    opts.onInfo?.("已居中角色（偏移归零）");
  });

  btnRefit.addEventListener("click", () => {
    opts.scene.refitCamera();
    opts.onInfo?.("已重置视角");
  });

  btnTestWalk.addEventListener("click", () => {
    opts.scene.notifyAction(makeTestAction("APPROACH", 1600));
    opts.onInfo?.("已触发本地走路测试（仅用于验证动作切换）");
  });

  btnSaveToLib.addEventListener("click", () => {
    void withBusy(btnSaveToLib, async () => {
      if (!lastVrmaBytes || !lastVrmaBytes.byteLength) {
        opts.onInfo?.("没有“最近加载的 VRMA”。请先点击「加载 VRMA…」。");
        return;
      }
      const suggested = lastVrmaSuggestedName ?? "new_action";
      const rawName = nameInput.value || suggested;
      const name = normalizeVrmaName(rawName);
      if (!name) {
        opts.onInfo?.("请输入一个动作名字。");
        nameInput.focus();
        return;
      }
      const existing = await vrmaGet(name);
      if (existing) {
        const ok = window.confirm(`动作库里已存在「${name}」。要覆盖保存吗？`);
        if (!ok) return;
      }
      const now = Date.now();
      const bytes = bytesToArrayBuffer(lastVrmaBytes);
      const createdAt = existing?.createdAt ?? now;
      await vrmaPut({ name, bytes, createdAt, updatedAt: now });
      opts.onInfo?.(`已保存到动作库：${shortName(name)}`);
      nameInput.value = "";
      await refreshLibraryList();
    });
  });

  btnImportToLib.addEventListener("click", () => {
    void withBusy(btnImportToLib, async () => {
      const picked = await pickFileViaFileInput(".vrma");
      if (!picked.bytes.byteLength) {
        opts.onInfo?.("未选择动作文件。");
        return;
      }
      lastVrmaBytes = picked.bytes;
      lastVrmaSuggestedName = picked.name ? stripExtension(picked.name) : null;
      const suggested = normalizeVrmaName(stripExtension(picked.name ?? "new_action"));
      if (!nameInput.value) nameInput.value = suggested;
      nameInput.focus();
      opts.onInfo?.("已导入动作（尚未保存）：请修改名字后点「保存」。");
    });
  });

  btnRefreshLib.addEventListener("click", () => {
    void withBusy(btnRefreshLib, async () => {
      await refreshLibraryList();
      opts.onInfo?.("已刷新动作库");
    });
  });

  void refreshLibraryList();

  // Advanced sections
  const animDetails = createDetails("动作 / VRMA（高级）", false);
  body.appendChild(animDetails.details);

  const animButtons = document.createElement("div");
  animButtons.className = "panelButtons";
  const clearIdleSlotBtn = document.createElement("button");
  clearIdleSlotBtn.className = "panelBtn";
  clearIdleSlotBtn.type = "button";
  clearIdleSlotBtn.textContent = "清除 Idle 槽";
  clearIdleSlotBtn.addEventListener("click", () => {
    opts.scene.clearVrmAnimationSlot("idle");
    opts.onInfo?.("已清除 Idle 槽位");
  });
  const clearWalkSlotBtn = document.createElement("button");
  clearWalkSlotBtn.className = "panelBtn";
  clearWalkSlotBtn.type = "button";
  clearWalkSlotBtn.textContent = "清除 Walk 槽";
  clearWalkSlotBtn.addEventListener("click", () => {
    opts.scene.clearVrmAnimationSlot("walk");
    opts.onInfo?.("已清除 Walk 槽位");
  });
  animButtons.append(clearIdleSlotBtn, clearWalkSlotBtn);
  animDetails.body.appendChild(animButtons);

  const animCfg = opts.scene.getVrmAnimationConfig();

  const animEnableCheck = document.createElement("label");
  animEnableCheck.className = "panelCheck";
  const animEnableInput = document.createElement("input");
  animEnableInput.type = "checkbox";
  animEnableInput.checked = Boolean(animCfg.enabled);
  animEnableInput.addEventListener("change", () => {
    const enabled = animEnableInput.checked;
    opts.scene.setVrmAnimationConfig({ enabled });
    stored.vrmAnimationConfig = { ...(stored.vrmAnimationConfig ?? {}), enabled };
    saveSettings(stored);
  });
  animEnableCheck.append(animEnableInput, document.createTextNode("启用 VRMA"));
  animDetails.body.appendChild(animEnableCheck);

  const animPauseCheck = document.createElement("label");
  animPauseCheck.className = "panelCheck";
  const animPauseInput = document.createElement("input");
  animPauseInput.type = "checkbox";
  animPauseInput.checked = Boolean(animCfg.paused);
  animPauseInput.addEventListener("change", () => {
    const paused = animPauseInput.checked;
    opts.scene.setVrmAnimationConfig({ paused });
    stored.vrmAnimationConfig = { ...(stored.vrmAnimationConfig ?? {}), paused };
    saveSettings(stored);
  });
  animPauseCheck.append(animPauseInput, document.createTextNode("暂停"));
  animDetails.body.appendChild(animPauseCheck);

  const animSpeedRow = createRangeRow({
    label: "速度",
    min: 0,
    max: 2.5,
    step: 0.01,
    value: animCfg.speed,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setVrmAnimationConfig({ speed: v });
      stored.vrmAnimationConfig = { ...(stored.vrmAnimationConfig ?? {}), speed: v };
      saveSettings(stored);
    }
  });
  animDetails.body.appendChild(animSpeedRow.row);

  const modelDetails = createDetails("模型（高级）", false);
  body.appendChild(modelDetails.details);

  const modelButtons = document.createElement("div");
  modelButtons.className = "panelButtons";

  const resetModelBtn = document.createElement("button");
  resetModelBtn.className = "panelBtn";
  resetModelBtn.type = "button";
  resetModelBtn.textContent = "重置模型参数";
  resetModelBtn.addEventListener("click", () => {
    opts.scene.setModelTransform({ scale: 1, yawDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 });
    opts.scene.refitCamera();
    stored.modelTransform = { scale: 1, yawDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };
    saveSettings(stored);
    opts.onInfo?.("已重置模型参数");
  });
  modelButtons.append(resetModelBtn);
  modelDetails.body.appendChild(modelButtons);

  const initialModel = opts.scene.getModelTransform();
  const scaleRow = createRangeRow({
    label: "缩放",
    min: 0.35,
    max: 2.5,
    step: 0.01,
    value: initialModel.scale,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setModelTransform({ scale: v });
      stored.modelTransform = { ...(stored.modelTransform ?? {}), scale: v };
      saveSettings(stored);
    }
  });
  modelDetails.body.appendChild(scaleRow.row);

  const yawRow = createRangeRow({
    label: "旋转(Yaw)",
    min: -180,
    max: 180,
    step: 1,
    value: initialModel.yawDeg,
    format: (v) => `${Math.round(v)}°`,
    onInput: (v) => {
      opts.scene.setModelTransform({ yawDeg: v });
      stored.modelTransform = { ...(stored.modelTransform ?? {}), yawDeg: v };
      saveSettings(stored);
    }
  });
  modelDetails.body.appendChild(yawRow.row);

  const offsetXRow = createRangeRow({
    label: "偏移 X",
    min: -0.7,
    max: 0.7,
    step: 0.01,
    value: initialModel.offsetX,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setModelTransform({ offsetX: v });
      stored.modelTransform = { ...(stored.modelTransform ?? {}), offsetX: v };
      saveSettings(stored);
    }
  });
  modelDetails.body.appendChild(offsetXRow.row);

  const offsetYRow = createRangeRow({
    label: "偏移 Y",
    min: -0.7,
    max: 0.7,
    step: 0.01,
    value: initialModel.offsetY,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setModelTransform({ offsetY: v });
      stored.modelTransform = { ...(stored.modelTransform ?? {}), offsetY: v };
      saveSettings(stored);
    }
  });
  modelDetails.body.appendChild(offsetYRow.row);

  const offsetZRow = createRangeRow({
    label: "偏移 Z",
    min: -0.7,
    max: 0.7,
    step: 0.01,
    value: initialModel.offsetZ,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setModelTransform({ offsetZ: v });
      stored.modelTransform = { ...(stored.modelTransform ?? {}), offsetZ: v };
      saveSettings(stored);
    }
  });
  modelDetails.body.appendChild(offsetZRow.row);

  const idleDetails = createDetails("待机（高级）", false);
  body.appendChild(idleDetails.details);

  const idleButtons = document.createElement("div");
  idleButtons.className = "panelButtons";
  const resetIdleBtn = document.createElement("button");
  resetIdleBtn.className = "panelBtn";
  resetIdleBtn.type = "button";
  resetIdleBtn.textContent = "重置待机参数";
  resetIdleBtn.addEventListener("click", () => {
    opts.scene.setIdleConfig(DEFAULT_IDLE_CONFIG);
    stored.idleConfig = { ...DEFAULT_IDLE_CONFIG };
    saveSettings(stored);
    opts.onInfo?.("已重置待机参数");
  });
  idleButtons.append(resetIdleBtn);
  idleDetails.body.appendChild(idleButtons);

  const currentIdle = opts.scene.getIdleConfig() ?? DEFAULT_IDLE_CONFIG;
  const enabledCheck = document.createElement("label");
  enabledCheck.className = "panelCheck";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = Boolean(currentIdle.enabled);
  enabledInput.addEventListener("change", () => {
    const enabled = enabledInput.checked;
    opts.scene.setIdleConfig({ enabled });
    stored.idleConfig = { ...(stored.idleConfig ?? {}), enabled };
    saveSettings(stored);
  });
  enabledCheck.append(enabledInput, document.createTextNode("启用待机"));
  idleDetails.body.appendChild(enabledCheck);

  const overlayCheck = document.createElement("label");
  overlayCheck.className = "panelCheck";
  const overlayInput = document.createElement("input");
  overlayInput.type = "checkbox";
  overlayInput.checked = Boolean(currentIdle.overlayOnAnimation);
  overlayInput.addEventListener("change", () => {
    const overlayOnAnimation = overlayInput.checked;
    opts.scene.setIdleConfig({ overlayOnAnimation });
    stored.idleConfig = { ...(stored.idleConfig ?? {}), overlayOnAnimation };
    saveSettings(stored);
  });
  overlayCheck.append(overlayInput, document.createTextNode("动作时叠加待机"));
  idleDetails.body.appendChild(overlayCheck);

  const idleSpeedRow = createRangeRow({
    label: "速度",
    min: 0.25,
    max: 2.5,
    step: 0.01,
    value: currentIdle.speed,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ speed: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), speed: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(idleSpeedRow.row);

  const idleStrengthRow = createRangeRow({
    label: "强度",
    min: 0,
    max: 1,
    step: 0.01,
    value: clamp(currentIdle.strength, 0, 1),
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ strength: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), strength: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(idleStrengthRow.row);

  const breatheRow = createRangeRow({
    label: "呼吸",
    min: 0,
    max: 1,
    step: 0.01,
    value: clamp(currentIdle.breathe, 0, 1),
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ breathe: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), breathe: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(breatheRow.row);

  const swayRow = createRangeRow({
    label: "摆动",
    min: 0,
    max: 1,
    step: 0.01,
    value: clamp(currentIdle.sway, 0, 1),
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ sway: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), sway: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(swayRow.row);

  const armsDownRow = createRangeRow({
    label: "手臂自然下垂",
    min: 0,
    max: 1,
    step: 0.01,
    value: clamp(currentIdle.armsDown, 0, 1),
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ armsDown: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), armsDown: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(armsDownRow.row);

  const elbowRow = createRangeRow({
    label: "手肘微弯",
    min: 0,
    max: 1,
    step: 0.01,
    value: clamp(currentIdle.elbowBend, 0, 1),
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      opts.scene.setIdleConfig({ elbowBend: v });
      stored.idleConfig = { ...(stored.idleConfig ?? {}), elbowBend: v };
      saveSettings(stored);
    }
  });
  idleDetails.body.appendChild(elbowRow.row);

  const walkDetails = createDetails("行走（程序动画，高级）", false);
  body.appendChild(walkDetails.details);

  const currentWalk = opts.scene.getWalkConfig();
  if (currentWalk) {
    const walkEnabledCheck = document.createElement("label");
    walkEnabledCheck.className = "panelCheck";
    const walkEnabledInput = document.createElement("input");
    walkEnabledInput.type = "checkbox";
    walkEnabledInput.checked = Boolean(currentWalk.enabled);
    walkEnabledInput.addEventListener("change", () => {
      const enabled = walkEnabledInput.checked;
      opts.scene.setWalkConfig({ enabled });
      stored.walkConfig = { ...(stored.walkConfig ?? {}), enabled };
      saveSettings(stored);
    });
    walkEnabledCheck.append(walkEnabledInput, document.createTextNode("启用行走"));
    walkDetails.body.appendChild(walkEnabledCheck);

    const walkSpeedRow = createRangeRow({
      label: "速度",
      min: 0.2,
      max: 2.5,
      step: 0.01,
      value: currentWalk.speed,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        opts.scene.setWalkConfig({ speed: v });
        stored.walkConfig = { ...(stored.walkConfig ?? {}), speed: v };
        saveSettings(stored);
      }
    });
    walkDetails.body.appendChild(walkSpeedRow.row);

    const strideRow = createRangeRow({
      label: "步幅",
      min: 0,
      max: 1,
      step: 0.01,
      value: clamp(currentWalk.stride, 0, 1),
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        opts.scene.setWalkConfig({ stride: v });
        stored.walkConfig = { ...(stored.walkConfig ?? {}), stride: v };
        saveSettings(stored);
      }
    });
    walkDetails.body.appendChild(strideRow.row);

    const armSwingRow = createRangeRow({
      label: "摆臂",
      min: 0,
      max: 1,
      step: 0.01,
      value: clamp(currentWalk.armSwing, 0, 1),
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        opts.scene.setWalkConfig({ armSwing: v });
        stored.walkConfig = { ...(stored.walkConfig ?? {}), armSwing: v };
        saveSettings(stored);
      }
    });
    walkDetails.body.appendChild(armSwingRow.row);

    const bounceRow = createRangeRow({
      label: "起伏",
      min: 0,
      max: 1,
      step: 0.01,
      value: clamp(currentWalk.bounce, 0, 1),
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        opts.scene.setWalkConfig({ bounce: v });
        stored.walkConfig = { ...(stored.walkConfig ?? {}), bounce: v };
        saveSettings(stored);
      }
    });
    walkDetails.body.appendChild(bounceRow.row);

    const leanRow = createRangeRow({
      label: "前倾",
      min: 0,
      max: 1,
      step: 0.01,
      value: clamp(currentWalk.lean, 0, 1),
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        opts.scene.setWalkConfig({ lean: v });
        stored.walkConfig = { ...(stored.walkConfig ?? {}), lean: v };
        saveSettings(stored);
      }
    });
    walkDetails.body.appendChild(leanRow.row);

    const resetWalkBtn = document.createElement("button");
    resetWalkBtn.className = "panelBtn";
    resetWalkBtn.type = "button";
    resetWalkBtn.textContent = "重置行走参数";
    resetWalkBtn.addEventListener("click", () => {
      opts.scene.setWalkConfig(DEFAULT_WALK_CONFIG);
      stored.walkConfig = { ...DEFAULT_WALK_CONFIG };
      saveSettings(stored);
      opts.onInfo?.("已重置行走参数");
    });
    walkDetails.body.appendChild(resetWalkBtn);
  } else {
    const hint = document.createElement("div");
    hint.style.color = "rgba(15, 23, 42, 0.62)";
    hint.textContent = "当前 VRM 未加载，或不支持 Humanoid 行走骨骼。";
    walkDetails.body.appendChild(hint);
  }

  const debugDetails = createDetails("调试", false);
  body.appendChild(debugDetails.details);

  const hudCheck = document.createElement("label");
  hudCheck.className = "panelCheck";
  const hudInput = document.createElement("input");
  hudInput.type = "checkbox";
  hudInput.checked = Boolean(stored.debugHudVisible);
  hudInput.addEventListener("change", () => {
    const visible = hudInput.checked;
    stored.debugHudVisible = visible;
    saveSettings(stored);
    if (hud) hud.style.display = visible ? "block" : "none";
  });
  hudCheck.append(hudInput, document.createTextNode("显示 HUD（性能/状态）"));
  debugDetails.body.appendChild(hudCheck);

  // Live status refresh (chips + button enablement)
  let clickThrough: boolean | null = null;
  const api: any = (window as any).stageDesktop;
  let llmProvider: string | null = null;
  void (async () => {
    try {
      if (!api || typeof api.getAppInfo !== "function") return;
      const info = await api.getAppInfo();
      const name = String(info?.llmProvider ?? "").trim();
      llmProvider = name || "unknown";
    } catch {
      llmProvider = "unknown";
    }
  })();
  const unsubClickThrough =
    api && typeof api.onClickThroughChanged === "function"
      ? api.onClickThroughChanged((enabled: boolean) => {
          clickThrough = Boolean(enabled);
        })
      : null;

  const refresh = () => {
    const modelOk = hasVrmLoaded(opts.scene);
    chipModel.textContent = `模型：${modelOk ? "已加载" : "未加载"}`;
    chipModel.className = `chip chipStrong${modelOk ? "" : ""}`;

    const llmLabel = llmProvider ?? "?";
    chipLLM.textContent = `LLM：${llmLabel === "fallback" ? "fallback（离线）" : llmLabel}`;
    chipLLM.className = `chip${llmLabel === "fallback" ? "" : " chipStrong"}`;

    const motion = opts.scene.getMotionState();
    chipMotion.textContent = `状态：${motion.locomotion} / ${motion.animation}`;

    chipClickThrough.textContent = `穿透：${
      clickThrough === null ? "?" : clickThrough ? "ON（无法拖动）" : "OFF（可拖动）"
    }`;

    const slots = opts.scene.getVrmAnimationSlotsStatus();
    const idleName = stored.vrmaSlotNames?.idle;
    const walkName = stored.vrmaSlotNames?.walk;
    chipVrma.textContent = `VRMA：idle=${slots.hasIdle ? "✓" : "-"}${idleName ? `(${shortName(idleName, 10)})` : ""} walk=${
      slots.hasWalk ? "✓" : "-"
    }${walkName ? `(${shortName(walkName, 10)})` : ""} last=${slots.hasLastLoaded ? "✓" : "-"} act=${
      slots.hasAction ? "✓" : "-"
    }`;

    btnSetIdle.disabled = !slots.hasLastLoaded;
    btnSetWalk.disabled = !slots.hasLastLoaded;
    btnStopAction.disabled = !slots.hasAction;
    clearIdleSlotBtn.disabled = !slots.hasIdle;
    clearWalkSlotBtn.disabled = !slots.hasWalk;

    btnSaveToLib.disabled = !lastVrmaBytes || !lastVrmaBytes.byteLength;
  };

  refresh();
  const refreshTimer = window.setInterval(refresh, 250);

  setPanelOpen(panelOpen);

  return () => {
    window.clearInterval(refreshTimer);
    try {
      unsubClickThrough?.();
    } catch {}
    try {
      unsubPetWindowState?.();
    } catch {}
    wrapper.remove();
  };
}
