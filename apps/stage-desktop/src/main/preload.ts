import { contextBridge, ipcRenderer } from "electron";
import type {
  ActionCommand,
  ChatRequest,
  ChatResponse,
  PetControlMessage,
  PetControlResult,
  PetStateMessage,
  PetStatusMessage,
  PetWindowStateMessage,
  UserInteraction
} from "@sama/shared";
import type { DragDelta, LLMConfig } from "./protocol/types";

type Unsubscribe = () => void;

// IMPORTANT: Keep preload self-contained (no workspace package runtime deps).
// Preload runs in a renderer context and should not depend on pnpm workspace resolution.
const IPC_CHANNELS = {
  actionCommand: "bus:action-command",
  userInteraction: "bus:user-interaction",
  dragDelta: "bus:drag-delta",
  clickThroughChanged: "bus:click-through-changed",
  chatRequest: "bus:chat-request",
  chatResponse: "bus:chat-response",
  petControl: "bus:pet-control",
  petControlResult: "bus:pet-control-result",
  petStatus: "bus:pet-status",
  petState: "bus:pet-state",
  petWindowState: "bus:pet-window-state"
} as const;

const IPC_HANDLES = {
  vrmGet: "handle:vrm-get",
  vrmPick: "handle:vrm-pick",
  chatInvoke: "handle:chat-invoke",
  appInfoGet: "handle:app-info-get",
  llmConfigGet: "handle:llm-config-get",
  llmConfigSet: "handle:llm-config-set"
} as const;

export type StageDesktopAPI = {
  onActionCommand: (cb: (cmd: ActionCommand) => void) => Unsubscribe;
  sendUserInteraction: (i: UserInteraction) => void;
  sendDragDelta: (d: DragDelta) => void;
  onClickThroughChanged: (cb: (enabled: boolean) => void) => Unsubscribe;
  getVrmBytes: () => Promise<Uint8Array>;
  pickVrmBytes: () => Promise<Uint8Array>;
  getAppInfo: () => Promise<{ vrmLocked: boolean; llmProvider: string }>;
  getLlmConfig: () => Promise<{
    storagePath: string;
    stored: LLMConfig | null;
    effective: LLMConfig | null;
    provider: string;
  }>;
  setLlmConfig: (config: LLMConfig) => Promise<{ ok: boolean; provider?: string; message?: string }>;
  chatInvoke: (message: string) => Promise<ChatResponse>;
  sendPetControl: (m: PetControlMessage) => void;
  onPetControl: (cb: (m: PetControlMessage) => void) => Unsubscribe;
  sendPetControlResult: (r: PetControlResult) => void;
  onPetControlResult: (cb: (r: PetControlResult) => void) => Unsubscribe;
  sendPetStatus: (s: PetStatusMessage) => void;
  onPetStatus: (cb: (s: PetStatusMessage) => void) => Unsubscribe;
  sendPetState: (s: PetStateMessage) => void;
  onPetState: (cb: (s: PetStateMessage) => void) => Unsubscribe;
  onPetWindowState: (cb: (s: PetWindowStateMessage) => void) => Unsubscribe;
};

const api: StageDesktopAPI = {
  onActionCommand: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: ActionCommand) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.actionCommand, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.actionCommand, handler);
  },
  onClickThroughChanged: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, enabled: boolean) => cb(Boolean(enabled));
    ipcRenderer.on(IPC_CHANNELS.clickThroughChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.clickThroughChanged, handler);
  },
  sendUserInteraction: (i) => ipcRenderer.send(IPC_CHANNELS.userInteraction, i),
  sendDragDelta: (d) => ipcRenderer.send(IPC_CHANNELS.dragDelta, d),
  getVrmBytes: () => ipcRenderer.invoke(IPC_HANDLES.vrmGet),
  pickVrmBytes: () => ipcRenderer.invoke(IPC_HANDLES.vrmPick),
  getAppInfo: async () => {
    const raw = await ipcRenderer.invoke(IPC_HANDLES.appInfoGet);
    return { vrmLocked: Boolean(raw?.vrmLocked), llmProvider: String(raw?.llmProvider ?? "") || "unknown" };
  },
  getLlmConfig: async () => ipcRenderer.invoke(IPC_HANDLES.llmConfigGet),
  setLlmConfig: async (config: LLMConfig) => ipcRenderer.invoke(IPC_HANDLES.llmConfigSet, config),
  chatInvoke: async (message: string) => {
    const req: ChatRequest = { type: "CHAT_REQUEST", ts: Date.now(), message };
    return ipcRenderer.invoke(IPC_HANDLES.chatInvoke, req);
  },
  sendPetControl: (m) => ipcRenderer.send(IPC_CHANNELS.petControl, m),
  onPetControl: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: PetControlMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.petControl, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.petControl, handler);
  },
  sendPetControlResult: (r) => ipcRenderer.send(IPC_CHANNELS.petControlResult, r),
  onPetControlResult: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: PetControlResult) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.petControlResult, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.petControlResult, handler);
  },
  sendPetStatus: (s) => ipcRenderer.send(IPC_CHANNELS.petStatus, s),
  onPetStatus: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: PetStatusMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.petStatus, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.petStatus, handler);
  },
  sendPetState: (s) => ipcRenderer.send(IPC_CHANNELS.petState, s),
  onPetState: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: PetStateMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.petState, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.petState, handler);
  },
  onPetWindowState: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: PetWindowStateMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.petWindowState, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.petWindowState, handler);
  }
};

contextBridge.exposeInMainWorld("stageDesktop", api);
