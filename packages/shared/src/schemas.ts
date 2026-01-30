import { z } from "zod";

export const SensorUpdateSchema = z.object({
  type: z.literal("SENSOR_UPDATE"),
  ts: z.number(),
  activeApp: z.string(),
  activeTitle: z.string().optional(),
  switchRate2m: z.number(),
  socialHits3m: z.number(),
  idleSec: z.number(),
  isNight: z.boolean()
});

export const ActionCommandSchema = z.object({
  type: z.literal("ACTION_COMMAND"),
  ts: z.number(),
  action: z.enum(["IDLE", "APPROACH", "RETREAT", "INVITE_CHAT"]),
  expression: z.enum(["NEUTRAL", "HAPPY", "SAD", "SHY", "TIRED", "ANGRY", "SURPRISED", "THINKING", "CONFUSED", "EXCITED"]),
  bubbleKind: z.enum(["text", "thinking"]).optional(),
  bubble: z.string().nullable().optional(),
  durationMs: z.number()
});

export const UserInteractionSchema = z.discriminatedUnion("event", [
  z.object({
    type: z.literal("USER_INTERACTION"),
    ts: z.number(),
    event: z.literal("CLICK_PET")
  }),
  z.object({
    type: z.literal("USER_INTERACTION"),
    ts: z.number(),
    event: z.literal("OPEN_CHAT")
  }),
  z.object({
    type: z.literal("USER_INTERACTION"),
    ts: z.number(),
    event: z.literal("CLOSE_CHAT")
  }),
  z.object({
    type: z.literal("USER_INTERACTION"),
    ts: z.number(),
    event: z.literal("IGNORED_ACTION"),
    action: z.enum(["IDLE", "APPROACH", "RETREAT", "INVITE_CHAT"])
  })
]);

export const ChatRequestSchema = z.object({
  type: z.literal("CHAT_REQUEST"),
  ts: z.number(),
  message: z.string().min(1).max(4000)
});

export const ChatResponseSchema = z.object({
  type: z.literal("CHAT_RESPONSE"),
  ts: z.number(),
  message: z.string()
});

export const ManualActionSchema = z.object({
  type: z.literal("MANUAL_ACTION"),
  ts: z.number(),
  action: z.enum(["IDLE", "APPROACH", "RETREAT", "INVITE_CHAT"]),
  expression: z.enum(["NEUTRAL", "HAPPY", "SAD", "SHY", "TIRED", "ANGRY", "SURPRISED", "THINKING", "CONFUSED", "EXCITED"]).optional()
});
