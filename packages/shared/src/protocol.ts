// Shared protocol types (MUST match spec)

export type SensorUpdate = {
  type: "SENSOR_UPDATE";
  ts: number;
  activeApp: string; // e.g., "WeChat.exe"
  activeTitle?: string; // optional window title
  switchRate2m: number; // switches in last 2 minutes
  socialHits3m: number; // social app foreground hits in last 3 minutes
  idleSec: number; // seconds since last input
  isNight: boolean; // 00:00-06:00 local time
};

export type ActionCommand = {
  type: "ACTION_COMMAND";
  ts: number;
  action: "IDLE" | "APPROACH" | "RETREAT" | "INVITE_CHAT";
  expression: "NEUTRAL" | "HAPPY" | "SAD" | "SHY" | "TIRED";
  bubble?: string | null;
  durationMs: number;
};

export type UserInteraction =
  | { type: "USER_INTERACTION"; ts: number; event: "CLICK_PET" }
  | { type: "USER_INTERACTION"; ts: number; event: "OPEN_CHAT" }
  | { type: "USER_INTERACTION"; ts: number; event: "CLOSE_CHAT" }
  | {
      type: "USER_INTERACTION";
      ts: number;
      event: "IGNORED_ACTION";
      action: ActionCommand["action"];
    };

export type ChatRequest = { type: "CHAT_REQUEST"; ts: number; message: string };
export type ChatResponse = { type: "CHAT_RESPONSE"; ts: number; message: string };

// Chat log (for UI). This is separate from the "bubble" UX.
export type ChatLogEntry = {
  id: string;
  ts: number;
  role: "user" | "assistant";
  content: string;
};

export type ChatLogMessage =
  | { type: "CHAT_LOG_SYNC"; ts: number; entries: ChatLogEntry[] }
  | { type: "CHAT_LOG_APPEND"; ts: number; entry: ChatLogEntry };

// Pet control protocol (controls window -> main -> pet renderer)
export type PetMotionState = {
  locomotion: "IDLE" | "WALK";
  animation: "NONE" | "IDLE" | "WALK" | "ACTION";
};

export type PetVrmAnimationSlotsStatus = {
  hasLastLoaded: boolean;
  hasIdle: boolean;
  hasWalk: boolean;
  hasAction: boolean;
};

export type PetModelTransform = {
  scale: number;
  yawDeg: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
};

export type PetIdleConfig = {
  enabled: boolean;
  strength: number;
  speed: number;
  breathe: number;
  sway: number;
  armsDown: number;
  elbowBend: number;
  overlayOnAnimation: boolean;
};

export type PetWalkConfig = {
  enabled: boolean;
  speed: number;
  stride: number;
  armSwing: number;
  bounce: number;
  lean: number;
};

export type PetVrmAnimationConfig = {
  enabled: boolean;
  paused: boolean;
  speed: number;
};

export type PetWindowSize = {
  width: number;
  height: number;
};

export type PetControlMessage =
  | { type: "PET_CONTROL"; ts: number; requestId?: string; action: "LOAD_VRM_BYTES"; bytes: Uint8Array }
  | { type: "PET_CONTROL"; ts: number; requestId?: string; action: "LOAD_VRMA_BYTES"; bytes: Uint8Array }
  | { type: "PET_CONTROL"; ts: number; action: "SET_MODEL_TRANSFORM"; transform: Partial<PetModelTransform> }
  | { type: "PET_CONTROL"; ts: number; requestId?: string; action: "SET_PET_WINDOW_SIZE"; size: Partial<PetWindowSize> }
  | { type: "PET_CONTROL"; ts: number; action: "REFIT_CAMERA" }
  | { type: "PET_CONTROL"; ts: number; action: "SPEAK" }
  | { type: "PET_CONTROL"; ts: number; action: "SET_IDLE_CONFIG"; config: Partial<PetIdleConfig> }
  | { type: "PET_CONTROL"; ts: number; action: "SET_WALK_CONFIG"; config: Partial<PetWalkConfig> }
  | { type: "PET_CONTROL"; ts: number; action: "SET_VRMA_CONFIG"; config: Partial<PetVrmAnimationConfig> }
  | { type: "PET_CONTROL"; ts: number; action: "CLEAR_VRMA_ACTION" }
  | { type: "PET_CONTROL"; ts: number; action: "ASSIGN_VRMA_SLOT_FROM_LAST"; slot: "idle" | "walk" }
  | { type: "PET_CONTROL"; ts: number; action: "CLEAR_VRMA_SLOT"; slot: "idle" | "walk" }
  | { type: "PET_CONTROL"; ts: number; action: "NOTIFY_ACTION"; cmd: ActionCommand };

export type PetControlResult = {
  type: "PET_CONTROL_RESULT";
  ts: number;
  requestId: string;
  ok: boolean;
  message?: string;
};

export type PetStatusMessage = {
  type: "PET_STATUS";
  ts: number;
  level: "info" | "error";
  message: string;
};

export type PetStateMessage = {
  type: "PET_STATE";
  ts: number;
  vrmLoaded: boolean;
  motion: PetMotionState;
  slots: PetVrmAnimationSlotsStatus;
};

export type PetWindowStateMessage = {
  type: "PET_WINDOW_STATE";
  ts: number;
  size: PetWindowSize;
};

export type AnyBusMessage =
  | SensorUpdate
  | ActionCommand
  | UserInteraction
  | ChatRequest
  | ChatResponse
  | ChatLogMessage
  | PetControlMessage
  | PetControlResult
  | PetStatusMessage
  | PetStateMessage
  | PetWindowStateMessage;
