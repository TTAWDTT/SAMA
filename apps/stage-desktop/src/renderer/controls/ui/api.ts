import type { ChatLogMessage, PetControlMessage, PetControlResult, PetStateMessage, PetWindowStateMessage } from "@sama/shared";

export type ToolInfo = {
  name: string;
  title?: string;
  description?: string;
  args?: string;
};

export type SkillInfo = {
  name: string;
  description?: string;
};

export type LlmConfig = {
  provider?: string;
  openai?: { apiKey?: string; model?: string; baseUrl?: string };
  deepseek?: { apiKey?: string; model?: string; baseUrl?: string };
  aistudio?: { apiKey?: string; model?: string; baseUrl?: string };
  webSearch?: { enabled?: boolean; tavilyApiKey?: string; maxResults?: number };
  tts?: { autoPlay?: boolean; voice?: string; rate?: number; pitch?: number; volume?: number };
  skills?: { dir?: string; enabled?: string[] };
  tools?: { enabled?: string[]; fsRoots?: string[]; maxReadBytes?: number };
};

export type ManualActionPayload = {
  type: "MANUAL_ACTION";
  ts: number;
  action: "IDLE" | "APPROACH" | "RETREAT" | "INVITE_CHAT";
  expression?: "NEUTRAL" | "HAPPY" | "SAD" | "SHY" | "TIRED";
};

export type AppLogMessage = {
  type: "APP_LOG";
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  scope?: string;
};

export type MemoryConfig = {
  injectLimit: number;
  autoRemember: boolean;
  autoMode: "rules" | "llm";
  summaryEnabled: boolean;
  llmRerank: boolean;
};

export type StageDesktopApi = {
  getAppInfo?: () => Promise<{ vrmLocked: boolean; llmProvider: string }>;
  onChatLog?: (cb: (msg: ChatLogMessage) => void) => () => void;
  getChatLog?: () => Promise<ChatLogMessage>;
  chatInvoke?: (payload: string | { message: string; images?: { dataUrl: string; name?: string }[]; meta?: { tools?: string[]; skills?: string[] } }) => Promise<any>;
  sendUserInteraction?: (i: any) => void;

  // Renderer helpers (preload wrappers)
  openExternal?: (url: string) => Promise<boolean> | boolean;
  clipboardWrite?: (text: string) => boolean;

  // Pet control (VRMA / motion tuning)
  sendPetControl?: (m: PetControlMessage) => void;
  onPetControlResult?: (cb: (r: PetControlResult) => void) => () => void;
  onPetState?: (cb: (s: PetStateMessage) => void) => () => void;
  onPetWindowState?: (cb: (s: PetWindowStateMessage) => void) => () => void;

  // Manual actions (controls -> main)
  sendManualAction?: (m: ManualActionPayload) => void;
  
  openControlsWindow?: () => Promise<{ ok: boolean; message?: string }>;

  // LLM config
  getLlmConfig?: () => Promise<{
    stored: LlmConfig | null;
    effective: LlmConfig | null;
    provider: string;
    skillsDir?: string;
    availableSkills?: string[];
  }>;
  setLlmConfig?: (cfg: LlmConfig) => Promise<{ ok: boolean; provider?: string; message?: string }>;

  // Long-term memory (SQLite) helpers
  getMemoryStats?: () => Promise<{ enabled: boolean; chatCount: number; noteCount: number; factCount: number }>;
  listMemoryNotes?: (
    limit: number
  ) => Promise<{ enabled: boolean; notes: { id: number; kind: string; content: string; updatedTs: number }[] }>;
  addMemoryNote?: (content: string) => Promise<{ ok: boolean }>;
  deleteMemoryNote?: (id: number) => Promise<{ ok: boolean }>;
  updateMemoryNote?: (id: number, content: string) => Promise<{ ok: boolean }>;
  getMemoryConfig?: () => Promise<{ enabled: boolean; config: MemoryConfig }>;
  setMemoryConfig?: (partial: Partial<MemoryConfig>) => Promise<{ ok: boolean; config: MemoryConfig }>;
  listMemoryFacts?: (
    limit: number
  ) => Promise<{ enabled: boolean; facts: { id: number; kind: string; key: string; value: string; updatedTs: number }[] }>;
  upsertMemoryFact?: (fact: { key: string; kind: string; value: string }) => Promise<{ ok: boolean }>;
  deleteMemoryFact?: (id: number) => Promise<{ ok: boolean }>;
  updateMemoryFact?: (id: number, value: string) => Promise<{ ok: boolean }>;
  getMemorySummary?: () => Promise<{ enabled: boolean; summary: string; summaryJson: any | null }>;
  clearMemorySummary?: () => Promise<{ ok: boolean }>;
  clearChatHistory?: () => Promise<{ ok: boolean }>;
  clearMemoryNotes?: () => Promise<{ ok: boolean }>;
  clearMemoryFacts?: () => Promise<{ ok: boolean }>;

  // App log forwarding (main -> controls)
  onAppLog?: (cb: (m: AppLogMessage) => void) => () => void;
};

export function getApi(): StageDesktopApi | null {
  return ((window as any).stageDesktop as StageDesktopApi | undefined) ?? null;
}
