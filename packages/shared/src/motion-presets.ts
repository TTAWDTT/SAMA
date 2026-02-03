import type { PetIdleConfig } from "./protocol";

/**
 * Built-in motion presets for SAMA.
 *
 * Notes:
 * - "idle_natural" is a procedural idle pose/config (no .vrma file required).
 * - VRMA presets are shipped as files under apps/stage-desktop/assets/vrma/.
 *   The main process loads the bytes and streams them to the pet renderer.
 */

export type MotionPresetId =
  | "idle_natural"
  | "vrma_01"
  | "vrma_03"
  | "vrma_04"
  | "vrma_05"
  | "vrma_06"
  | "vrma_07";

export type MotionPreset =
  | {
      id: "idle_natural";
      kind: "idle_config";
      name: string;
      nameEn: string;
      description?: string;
      idleConfig: Partial<PetIdleConfig>;
    }
  | {
      id: Exclude<MotionPresetId, "idle_natural">;
      kind: "vrma_asset";
      name: string;
      nameEn: string;
      description?: string;
      assetFile: string;
    };

export const DEFAULT_MOTION_PRESET_ID: MotionPresetId = "idle_natural";

export const MOTION_PRESETS: MotionPreset[] = [
  {
    id: "idle_natural",
    kind: "idle_config",
    name: "自然待机（双手下垂）",
    nameEn: "Natural idle (arms down)",
    description: "更自然的放松站姿，适合作为启动默认待机。",
    idleConfig: {
      enabled: true,
      strength: 1,
      speed: 1,
      breathe: 0.55,
      sway: 0.35,
      armsDown: 1,
      elbowBend: 0.6,
      overlayOnAnimation: false
    }
  },
  {
    id: "vrma_01",
    kind: "vrma_asset",
    name: "展示全身",
    nameEn: "Show full body",
    assetFile: "VRMA_01.vrma",
    description: "展示角色全身的动作（来自 VRMA_MotionPack）"
  },
  {
    id: "vrma_03",
    kind: "vrma_asset",
    name: "比耶",
    nameEn: "Peace sign",
    assetFile: "VRMA_03.vrma",
    description: "可爱的剪刀手（来自 VRMA_MotionPack）"
  },
  {
    id: "vrma_04",
    kind: "vrma_asset",
    name: "射击",
    nameEn: "Shoot",
    assetFile: "VRMA_04.vrma",
    description: "手枪射击姿势（来自 VRMA_MotionPack）"
  },
  {
    id: "vrma_05",
    kind: "vrma_asset",
    name: "转圈",
    nameEn: "Spin",
    assetFile: "VRMA_05.vrma",
    description: "原地转圈（来自 VRMA_MotionPack）"
  },
  {
    id: "vrma_06",
    kind: "vrma_asset",
    name: "模特姿势",
    nameEn: "Model pose",
    assetFile: "VRMA_06.vrma",
    description: "摆拍姿势（来自 VRMA_MotionPack）"
  },
  {
    id: "vrma_07",
    kind: "vrma_asset",
    name: "下蹲",
    nameEn: "Squat",
    assetFile: "VRMA_07.vrma",
    description: "蹲下动作（来自 VRMA_MotionPack）"
  }
];

/** Presets used by the pet-window quick "切换动作" button. */
export const MOTION_PRESET_CYCLE: MotionPresetId[] = [
  "vrma_01",
  "vrma_03",
  "vrma_04",
  "vrma_05",
  "vrma_06",
  "vrma_07"
];

export function getMotionPreset(id: MotionPresetId): MotionPreset | undefined {
  return MOTION_PRESETS.find((p) => p.id === id);
}

