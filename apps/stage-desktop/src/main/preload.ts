import { clipboard, contextBridge, ipcRenderer, shell } from "electron";
import type {
  ActionCommand,
  ChatRequest,
  ChatResponse,
  ChatLogMessage,
  AppLogMessage,
  ManualActionMessage,
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
  manualAction: "bus:manual-action",
  dragDelta: "bus:drag-delta",
  clickThroughChanged: "bus:click-through-changed",
  chatRequest: "bus:chat-request",
  chatResponse: "bus:chat-response",
  chatLog: "bus:chat-log",
  appLog: "bus:app-log",
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
  chatLogGet: "handle:chat-log-get",
  appInfoGet: "handle:app-info-get",
  llmConfigGet: "handle:llm-config-get",
  llmConfigSet: "handle:llm-config-set",
  availableToolsGet: "handle:available-tools-get",
  availableSkillsGet: "handle:available-skills-get",
  memoryStatsGet: "handle:memory-stats-get",
  memoryConfigGet: "handle:memory-config-get",
  memoryConfigSet: "handle:memory-config-set",
  memoryNotesList: "handle:memory-notes-list",
  memoryNoteAdd: "handle:memory-note-add",
  memoryNoteDelete: "handle:memory-note-delete",
  memoryNoteUpdate: "handle:memory-note-update",
  memoryFactsList: "handle:memory-facts-list",
  memoryFactUpsert: "handle:memory-fact-upsert",
  memoryFactDelete: "handle:memory-fact-delete",
  memoryFactUpdate: "handle:memory-fact-update",
  memorySummaryGet: "handle:memory-summary-get",
  memorySummaryClear: "handle:memory-summary-clear",
  memoryClearChat: "handle:memory-clear-chat",
  memoryClearNotes: "handle:memory-clear-notes",
  memoryClearFacts: "handle:memory-clear-facts"
} as const;

export type StageDesktopAPI = {
  onActionCommand: (cb: (cmd: ActionCommand) => void) => Unsubscribe;
  sendUserInteraction: (i: UserInteraction) => void;
  sendManualAction: (m: ManualActionMessage) => void;
  sendDragDelta: (d: DragDelta) => void;
  onClickThroughChanged: (cb: (enabled: boolean) => void) => Unsubscribe;
  onAppLog: (cb: (m: AppLogMessage) => void) => Unsubscribe;
  onChatLog: (cb: (msg: ChatLogMessage) => void) => Unsubscribe;
  getChatLog: () => Promise<ChatLogMessage>;
  getVrmBytes: () => Promise<Uint8Array>;
  pickVrmBytes: () => Promise<Uint8Array>;
  getAppInfo: () => Promise<{ vrmLocked: boolean; llmProvider: string }>;
  getLlmConfig: () => Promise<{
    storagePath: string;
    stored: LLMConfig | null;
    effective: LLMConfig | null;
    provider: string;
    skillsDir?: string;
    availableSkills?: string[];
  }>;
  setLlmConfig: (config: LLMConfig) => Promise<{ ok: boolean; provider?: string; message?: string }>;
  getMemoryStats: () => Promise<{ enabled: boolean; chatCount: number; noteCount: number; factCount: number }>;
  getMemoryConfig: () => Promise<{
    enabled: boolean;
    config: {
      injectLimit: number;
      autoRemember: boolean;
      autoMode: "rules" | "llm";
      summaryEnabled: boolean;
      llmRerank: boolean;
    };
  }>;
  setMemoryConfig: (
    partial: Partial<{
      injectLimit: number;
      autoRemember: boolean;
      autoMode: "rules" | "llm";
      summaryEnabled: boolean;
      llmRerank: boolean;
    }>
  ) => Promise<{
    ok: boolean;
    config: {
      injectLimit: number;
      autoRemember: boolean;
      autoMode: "rules" | "llm";
      summaryEnabled: boolean;
      llmRerank: boolean;
    };
  }>;
  listMemoryNotes: (
    limit: number
  ) => Promise<{ enabled: boolean; notes: { id: number; kind: string; content: string; updatedTs: number }[] }>;
  addMemoryNote: (content: string) => Promise<{ ok: boolean }>;
  deleteMemoryNote: (id: number) => Promise<{ ok: boolean }>;
  updateMemoryNote: (id: number, content: string) => Promise<{ ok: boolean }>;

  listMemoryFacts: (
    limit: number
  ) => Promise<{ enabled: boolean; facts: { id: number; kind: string; key: string; value: string; updatedTs: number }[] }>;
  upsertMemoryFact: (fact: { key: string; kind: string; value: string }) => Promise<{ ok: boolean }>;
  deleteMemoryFact: (id: number) => Promise<{ ok: boolean }>;
  updateMemoryFact: (id: number, value: string) => Promise<{ ok: boolean }>;

  getMemorySummary: () => Promise<{ enabled: boolean; summary: string; summaryJson: any | null }>;
  clearMemorySummary: () => Promise<{ ok: boolean }>;

  clearChatHistory: () => Promise<{ ok: boolean }>;
  clearMemoryNotes: () => Promise<{ ok: boolean }>;
  clearMemoryFacts: () => Promise<{ ok: boolean }>;
  chatInvoke: (payload: string | { message: string; meta?: { tools?: string[]; skills?: string[] } }) => Promise<ChatResponse>;

  // Tools and Skills
  getAvailableTools: () => Promise<{ tools: { name: string; title: string; description: string }[] }>;
  getAvailableSkills: () => Promise<{ skills: { name: string; description?: string }[] }>;

  sendPetControl: (m: PetControlMessage) => void;
  onPetControl: (cb: (m: PetControlMessage) => void) => Unsubscribe;
  sendPetControlResult: (r: PetControlResult) => void;
  onPetControlResult: (cb: (r: PetControlResult) => void) => Unsubscribe;
  sendPetStatus: (s: PetStatusMessage) => void;
  onPetStatus: (cb: (s: PetStatusMessage) => void) => Unsubscribe;
  sendPetState: (s: PetStateMessage) => void;
  onPetState: (cb: (s: PetStateMessage) => void) => Unsubscribe;
  onPetWindowState: (cb: (s: PetWindowStateMessage) => void) => Unsubscribe;

  // Renderer helpers (safe wrappers)
  openExternal: (url: string) => Promise<boolean>;
  clipboardWrite: (text: string) => boolean;
};

function sanitizeExternalUrl(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const proto = u.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:" || proto === "mailto:") return u.toString();
    return null;
  } catch {
    return null;
  }
}

const api: StageDesktopAPI = {
  onActionCommand: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: ActionCommand) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.actionCommand, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.actionCommand, handler);
  },
  onAppLog: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: AppLogMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.appLog, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.appLog, handler);
  },
  onChatLog: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: ChatLogMessage) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.chatLog, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.chatLog, handler);
  },
  onClickThroughChanged: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, enabled: boolean) => cb(Boolean(enabled));
    ipcRenderer.on(IPC_CHANNELS.clickThroughChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.clickThroughChanged, handler);
  },
  sendUserInteraction: (i) => ipcRenderer.send(IPC_CHANNELS.userInteraction, i),
  sendManualAction: (m) => ipcRenderer.send(IPC_CHANNELS.manualAction, m),
  sendDragDelta: (d) => ipcRenderer.send(IPC_CHANNELS.dragDelta, d),
  getChatLog: async () => ipcRenderer.invoke(IPC_HANDLES.chatLogGet),
  getVrmBytes: () => ipcRenderer.invoke(IPC_HANDLES.vrmGet),
  pickVrmBytes: () => ipcRenderer.invoke(IPC_HANDLES.vrmPick),
  getAppInfo: async () => {
    const raw = await ipcRenderer.invoke(IPC_HANDLES.appInfoGet);
    return { vrmLocked: Boolean(raw?.vrmLocked), llmProvider: String(raw?.llmProvider ?? "") || "unknown" };
  },
  getLlmConfig: async () => ipcRenderer.invoke(IPC_HANDLES.llmConfigGet),
  setLlmConfig: async (config: LLMConfig) => ipcRenderer.invoke(IPC_HANDLES.llmConfigSet, config),
  getMemoryStats: async () => ipcRenderer.invoke(IPC_HANDLES.memoryStatsGet),
  getMemoryConfig: async () => ipcRenderer.invoke(IPC_HANDLES.memoryConfigGet),
  setMemoryConfig: async (partial) => ipcRenderer.invoke(IPC_HANDLES.memoryConfigSet, partial),
  listMemoryNotes: async (limit: number) => ipcRenderer.invoke(IPC_HANDLES.memoryNotesList, limit),
  addMemoryNote: async (content: string) => ipcRenderer.invoke(IPC_HANDLES.memoryNoteAdd, { content }),
  deleteMemoryNote: async (id: number) => ipcRenderer.invoke(IPC_HANDLES.memoryNoteDelete, { id }),
  updateMemoryNote: async (id: number, content: string) => ipcRenderer.invoke(IPC_HANDLES.memoryNoteUpdate, { id, content }),
  listMemoryFacts: async (limit: number) => ipcRenderer.invoke(IPC_HANDLES.memoryFactsList, limit),
  upsertMemoryFact: async (fact: { key: string; kind: string; value: string }) =>
    ipcRenderer.invoke(IPC_HANDLES.memoryFactUpsert, { fact }),
  deleteMemoryFact: async (id: number) => ipcRenderer.invoke(IPC_HANDLES.memoryFactDelete, { id }),
  updateMemoryFact: async (id: number, value: string) => ipcRenderer.invoke(IPC_HANDLES.memoryFactUpdate, { id, value }),
  getMemorySummary: async () => ipcRenderer.invoke(IPC_HANDLES.memorySummaryGet),
  clearMemorySummary: async () => ipcRenderer.invoke(IPC_HANDLES.memorySummaryClear),
  clearChatHistory: async () => ipcRenderer.invoke(IPC_HANDLES.memoryClearChat),
  clearMemoryNotes: async () => ipcRenderer.invoke(IPC_HANDLES.memoryClearNotes),
  clearMemoryFacts: async () => ipcRenderer.invoke(IPC_HANDLES.memoryClearFacts),
  getAvailableTools: async () => ipcRenderer.invoke(IPC_HANDLES.availableToolsGet),
  getAvailableSkills: async () => ipcRenderer.invoke(IPC_HANDLES.availableSkillsGet),
  chatInvoke: async (payload) => {
    const message = typeof payload === "string" ? payload : String(payload?.message ?? "");
    const meta = typeof payload === "string" ? undefined : (payload as any)?.meta;
    const req: ChatRequest = {
      type: "CHAT_REQUEST",
      ts: Date.now(),
      message,
      meta: meta && typeof meta === "object" ? meta : undefined
    };
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
  },

  openControlsWindow: () => ipcRenderer.invoke("handle:controls-window-open", {}),

  openExternal: async (url) => {
    const safe = sanitizeExternalUrl(url);
    if (!safe) return false;
    try {
      await shell.openExternal(safe);
      return true;
    } catch {
      return false;
    }
  },
  clipboardWrite: (text) => {
    const t = String(text ?? "");
    if (!t) return false;
    try {
      clipboard.writeText(t);
      return true;
    } catch {
      return false;
    }
  }
};

contextBridge.exposeInMainWorld("stageDesktop", api);
