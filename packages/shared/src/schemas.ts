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
  message: z.string().max(4000),
  images: z
    .array(
      z.object({
        dataUrl: z
          .string()
          .min(32)
          // NOTE: base64 data URLs can be large; keep a reasonable cap to avoid IPC abuse.
          .max(12_000_000)
          .refine((s) => s.startsWith("data:image/") && s.includes(";base64,"), "invalid image data URL"),
        name: z.string().max(260).optional()
      })
    )
    .max(4)
    .optional(),
  meta: z
    .object({
      tools: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional()
    })
    .optional()
}).refine((d) => Boolean(d.message?.trim()) || (Array.isArray(d.images) && d.images.length > 0), {
  message: "message must not be empty unless images are provided",
  path: ["message"]
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
