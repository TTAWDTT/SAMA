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
  appInfoGet: "handle:app-info-get",
  llmConfigGet: "handle:llm-config-get",
  llmConfigSet: "handle:llm-config-set"
} as const;
