export const IPC_CHANNELS = {
  actionCommand: "bus:action-command",
  userInteraction: "bus:user-interaction",
  dragDelta: "bus:drag-delta",
  clickThroughChanged: "bus:click-through-changed",
  chatRequest: "bus:chat-request",
  chatResponse: "bus:chat-response",
  chatLog: "bus:chat-log",
  petControl: "bus:pet-control",
  petControlResult: "bus:pet-control-result",
  petStatus: "bus:pet-status",
  petState: "bus:pet-state",
  petWindowState: "bus:pet-window-state"
} as const;

export const IPC_HANDLES = {
  vrmGet: "handle:vrm-get",
  vrmPick: "handle:vrm-pick",
  chatInvoke: "handle:chat-invoke",
  chatLogGet: "handle:chat-log-get",
  appInfoGet: "handle:app-info-get",
  llmConfigGet: "handle:llm-config-get",
  llmConfigSet: "handle:llm-config-set",

  // Long-term memory (SQLite). These are optional at runtime (SQLite may be disabled).
  memoryStatsGet: "handle:memory-stats-get",
  memoryConfigGet: "handle:memory-config-get",
  memoryConfigSet: "handle:memory-config-set",
  memoryNotesList: "handle:memory-notes-list",
  memoryNoteAdd: "handle:memory-note-add",
  memoryNoteDelete: "handle:memory-note-delete",
  memoryNoteUpdate: "handle:memory-note-update",
  memoryClearChat: "handle:memory-clear-chat",
  memoryClearNotes: "handle:memory-clear-notes"
} as const;
