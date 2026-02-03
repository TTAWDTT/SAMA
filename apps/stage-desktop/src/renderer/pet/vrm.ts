import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";

export type LoadedVrm = {
  vrm: VRM;
  animations: THREE.AnimationClip[];
};

export async function loadVrmFromBytes(bytes: Uint8Array): Promise<LoadedVrm | null> {
  if (!bytes.byteLength) return null;
  // `BlobPart` typing is strict around `ArrayBuffer` vs `SharedArrayBuffer` in newer TS libs.
  // We only need a plain ArrayBuffer for object URLs, so copy into an ArrayBuffer safely.
  const arrayBuffer: ArrayBuffer =
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : (bytes.slice().buffer as ArrayBuffer);
  const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  try {
    const loader = new GLTFLoader();
    loader.register((parser: any) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = (gltf.userData as any).vrm as VRM | undefined;
    if (!vrm) return null;

    // Basic cleanup / compatibility helpers (inspired by common three-vrm practices)
    try {
      VRMUtils.rotateVRM0(vrm);
    } catch {}
    try {
      VRMUtils.removeUnnecessaryJoints(vrm.scene);
    } catch {}
    try {
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
    } catch {}

    const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
    return { vrm, animations };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type ExpressionName =
  | "NEUTRAL"
  | "HAPPY"
  | "SAD"
  | "SHY"
  | "TIRED"
  | "ANGRY"
  | "SURPRISED"
  | "THINKING"
  | "CONFUSED"
  | "EXCITED";

const TARGETS: Record<ExpressionName, Record<string, number>> = {
  NEUTRAL: {},
  HAPPY: { happy: 1 },
  SAD: { sad: 1 },
  SHY: { relaxed: 1 },
  TIRED: { relaxed: 0.7, sad: 0.25 },
  ANGRY: { angry: 1 },
  SURPRISED: { surprised: 1 },
  THINKING: { neutral: 0.5, lookUp: 0.3 },
  CONFUSED: { sad: 0.3, surprised: 0.4 },
  EXCITED: { happy: 0.8, surprised: 0.5 }
};

export function updateExpressions(vrm: VRM, current: Record<string, number>, targetName: ExpressionName) {
  const target = TARGETS[targetName];
  const mgr: any = (vrm as any).expressionManager;
  if (!mgr || typeof mgr.setValue !== "function") return;

  const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
  for (const k of keys) {
    const cur = current[k] ?? 0;
    const tar = target[k] ?? 0;
    const next = THREE.MathUtils.lerp(cur, tar, 0.15);
    current[k] = next;
    mgr.setValue(k, next);
  }
}
