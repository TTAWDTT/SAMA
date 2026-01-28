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

export type LLMConfig = {
  provider?: LLMProviderName;
  openai?: OpenAIConfig;
  deepseek?: DeepSeekConfig;
  aistudio?: AIStudioConfig;
};

export type AppConfig = {
  socialApps: string[];
  captionOffset?: { x: number; y: number };
  llm?: LLMConfig;
};

export type DragDelta = { dx: number; dy: number };
