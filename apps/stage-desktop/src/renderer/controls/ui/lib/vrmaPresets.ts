/**
 * Preset VRMA animations from the VRMA_MotionPack.
 * Animation credits to pixiv Inc.'s VRoid Project
 */

// Import VRMA files as static assets
import vrma01 from "../assets/vrma/VRMA_01.vrma?url";
import vrma03 from "../assets/vrma/VRMA_03.vrma?url";
import vrma04 from "../assets/vrma/VRMA_04.vrma?url";
import vrma05 from "../assets/vrma/VRMA_05.vrma?url";
import vrma06 from "../assets/vrma/VRMA_06.vrma?url";
import vrma07 from "../assets/vrma/VRMA_07.vrma?url";

export type VrmaPreset = {
  id: string;
  name: string;
  nameEn: string;
  url: string;
  description?: string;
};

export const VRMA_PRESETS: VrmaPreset[] = [
  {
    id: "vrma_01",
    name: "展示全身",
    nameEn: "Show full body",
    url: vrma01,
    description: "展示角色全身的动作"
  },
  {
    id: "vrma_03",
    name: "比耶",
    nameEn: "Peace sign",
    url: vrma03,
    description: "可爱的剪刀手"
  },
  {
    id: "vrma_04",
    name: "射击",
    nameEn: "Shoot",
    url: vrma04,
    description: "手枪射击姿势"
  },
  {
    id: "vrma_05",
    name: "转圈",
    nameEn: "Spin",
    url: vrma05,
    description: "原地转圈"
  },
  {
    id: "vrma_06",
    name: "模特姿势",
    nameEn: "Model pose",
    url: vrma06,
    description: "摆拍姿势"
  },
  {
    id: "vrma_07",
    name: "下蹲",
    nameEn: "Squat",
    url: vrma07,
    description: "蹲下动作"
  }
];

// Helper to get preset by ID
export function getPresetById(id: string): VrmaPreset | undefined {
  return VRMA_PRESETS.find(p => p.id === id);
}

// Helper to load preset bytes
export async function loadPresetBytes(preset: VrmaPreset): Promise<Uint8Array> {
  const response = await fetch(preset.url);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
