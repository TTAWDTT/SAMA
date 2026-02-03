export type CompanionState = "FOCUS" | "IDLE" | "FRAGMENTED" | "SOCIAL_CHECK_LOOP";

export type LLMProviderName = "auto" | "off" | "openai" | "deepseek" | "aistudio";

export type OpenAIConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type DeepSeekConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type AIStudioConfig = {
  apiKey?: string;
  model?: string;
  // Optional: if you have an OpenAI-compatible gateway, set baseUrl; otherwise uses Google AI Studio endpoint.
  baseUrl?: string;
};

export type WebSearchConfig = {
  enabled?: boolean;
  /** Tavily API key (optional; can also be set via env TAVILY_API_KEY). */
  tavilyApiKey?: string;
  maxResults?: number;
};

export type TtsConfig = {
  /** When true, automatically speak SAMA's assistant replies. */
  autoPlay?: boolean;
  /** Voice name (SpeechSynthesisVoice.name). Empty/undefined means "auto". */
  voice?: string;
  /** Speech rate (0.1 ~ 10, but we clamp to a safe range). */
  rate?: number;
  /** Speech pitch (0 ~ 2, but we clamp to a safe range). */
  pitch?: number;
  /** Volume (0 ~ 1). */
  volume?: number;
};

export type SkillsConfig = {
  /** Skills directory (default: ~/.claude/skills). */
  dir?: string;
  /** Enabled skill folder names. */
  enabled?: string[];
};

export type ToolsConfig = {
  /** Enabled tool names (global allowlist). */
  enabled?: string[];
  /** Allowed filesystem roots for fs_* tools (optional). */
  fsRoots?: string[];
  /** Max bytes returned by fs_read/fetch_url (best-effort). */
  maxReadBytes?: number;
};

export type LLMConfig = {
  provider?: LLMProviderName;
  openai?: OpenAIConfig;
  deepseek?: DeepSeekConfig;
  aistudio?: AIStudioConfig;
  webSearch?: WebSearchConfig;
  tts?: TtsConfig;
  skills?: SkillsConfig;
  tools?: ToolsConfig;
};

export type AppConfig = {
  socialApps: string[];
  captionOffset?: { x: number; y: number };
  llm?: LLMConfig;
  vrm?: {
    /** When true, the app will always use the configured VRM model and prevent switching via UI/drag. */
    locked?: boolean;
    /** Absolute path (recommended via config.local.json) or path relative to apps/stage-desktop/. */
    path?: string;
  };
};

export type DragDelta = { dx: number; dy: number };
