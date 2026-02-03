import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

export type WalkConfig = {
  enabled: boolean;
  /** Time scale multiplier for the gait cycle. */
  speed: number;
  /** Step amplitude [0..1]. */
  stride: number;
  /** Arm swing amplitude [0..1]. */
  armSwing: number;
  /** Vertical body bob [0..1]. */
  bounce: number;
  /** Forward lean [0..1]. */
  lean: number;
};

export type WalkController = {
  apply: (dt: number, t: number, opts?: { intensity?: number }) => void;
  setConfig: (next: Partial<WalkConfig>) => void;
  getConfig: () => WalkConfig;
};

const DEFAULT_WALK_CONFIG: WalkConfig = {
  enabled: true,
  speed: 1,
  stride: 0.75,
  armSwing: 0.6,
  bounce: 0.5,
  lean: 0.35
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function dampAlpha(dt: number, lambda: number) {
  return 1 - Math.exp(-Math.max(0, lambda) * Math.max(0, dt));
}

type BoneName =
  | "hips"
  | "spine"
  | "chest"
  | "head"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "leftFoot"
  | "rightUpperLeg"
  | "rightLowerLeg"
  | "rightFoot"
  | "leftUpperArm"
  | "leftLowerArm"
  | "rightUpperArm"
  | "rightLowerArm";

function getNormalizedBoneNode(vrm: VRM, name: BoneName): THREE.Object3D | null {
  const humanoid: any = (vrm as any).humanoid;
  const node = humanoid?.getNormalizedBoneNode?.(name);
  return node && (node as any).isObject3D ? (node as THREE.Object3D) : null;
}

export function createWalkController(vrm: VRM, initial?: Partial<WalkConfig>): WalkController {
  const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, ...(initial ?? {}) };

  const bones: Partial<Record<BoneName, THREE.Object3D>> = {
    hips: getNormalizedBoneNode(vrm, "hips") ?? undefined,
    spine: getNormalizedBoneNode(vrm, "spine") ?? undefined,
    chest: getNormalizedBoneNode(vrm, "chest") ?? undefined,
    head: getNormalizedBoneNode(vrm, "head") ?? undefined,

    leftUpperLeg: getNormalizedBoneNode(vrm, "leftUpperLeg") ?? undefined,
    leftLowerLeg: getNormalizedBoneNode(vrm, "leftLowerLeg") ?? undefined,
    leftFoot: getNormalizedBoneNode(vrm, "leftFoot") ?? undefined,
    rightUpperLeg: getNormalizedBoneNode(vrm, "rightUpperLeg") ?? undefined,
    rightLowerLeg: getNormalizedBoneNode(vrm, "rightLowerLeg") ?? undefined,
    rightFoot: getNormalizedBoneNode(vrm, "rightFoot") ?? undefined,

    leftUpperArm: getNormalizedBoneNode(vrm, "leftUpperArm") ?? undefined,
    leftLowerArm: getNormalizedBoneNode(vrm, "leftLowerArm") ?? undefined,
    rightUpperArm: getNormalizedBoneNode(vrm, "rightUpperArm") ?? undefined,
    rightLowerArm: getNormalizedBoneNode(vrm, "rightLowerArm") ?? undefined
  };

  const restQ = new Map<THREE.Object3D, THREE.Quaternion>();
  const restP = new Map<THREE.Object3D, THREE.Vector3>();

  for (const bone of Object.values(bones)) {
    if (!bone) continue;
    restQ.set(bone, bone.quaternion.clone());
    restP.set(bone, bone.position.clone());
  }

  const tmpQ1 = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpV1 = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  function applyLocalRotation(
    bone: THREE.Object3D | undefined,
    offsetEuler: THREE.Euler,
    weight: number,
    dt: number,
    smoothLambda: number
  ) {
    if (!bone) return;
    const rest = restQ.get(bone);
    if (!rest) return;

    tmpQ1.copy(rest);
    tmpQ2.setFromEuler(offsetEuler);
    tmpQ1.multiply(tmpQ2);

    tmpQ2.copy(rest).slerp(tmpQ1, clamp01(weight));
    bone.quaternion.slerp(tmpQ2, dampAlpha(dt, smoothLambda));
  }

  function applyLocalPosition(
    bone: THREE.Object3D | undefined,
    offset: THREE.Vector3,
    weight: number,
    dt: number,
    smoothLambda: number
  ) {
    if (!bone) return;
    const rest = restP.get(bone);
    if (!rest) return;

    tmpV1.copy(rest);
    tmpV2.copy(rest).add(offset);
    tmpV1.lerp(tmpV2, clamp01(weight));
    bone.position.lerp(tmpV1, dampAlpha(dt, smoothLambda));
  }

  return {
    apply: (dt, t, opts) => {
      const intensity = clamp01(Number(opts?.intensity ?? 1));
      // When disabled or at zero intensity, we still tick so bones can smoothly return to rest
      // (important when stopping after a brief walk).
      const weight = config.enabled ? intensity : 0;

      const speed = Math.max(0.01, Number(config.speed) || 1);
      const stride = clamp01(Number(config.stride) || 0) * weight;
      const armSwing = clamp01(Number(config.armSwing) || 0) * weight;
      const bounce = clamp01(Number(config.bounce) || 0) * weight;
      const lean = clamp01(Number(config.lean) || 0) * weight;

      // A gentle, VRoid-like walking cadence.
      const time = t * speed;
      const phase = time * (Math.PI * 2) * 1.35; // ~1.35 steps/sec

      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const s2 = Math.sin(phase * 2);

      // Hips: slight yaw sway + vertical bob.
      tmpEuler.set(0, stride * s * 0.08, stride * s * 0.01);
      applyLocalRotation(bones.hips, tmpEuler, weight, dt, 16);
      tmpV1.set(0, bounce * Math.abs(s) * 0.018, 0);
      applyLocalPosition(bones.hips, tmpV1, weight, dt, 16);

      // Spine / chest: forward lean and counter sway to keep balance.
      tmpEuler.set(lean * 0.08 + bounce * Math.abs(s) * 0.02, 0, -stride * s * 0.02);
      applyLocalRotation(bones.spine, tmpEuler, weight, dt, 16);
      tmpEuler.set(lean * 0.06, 0, -stride * s * 0.025);
      applyLocalRotation(bones.chest, tmpEuler, weight, dt, 16);
      tmpEuler.set(-lean * 0.02, 0, stride * s * 0.012);
      applyLocalRotation(bones.head, tmpEuler, weight, dt, 18);

      // Legs
      // Left forward when s>0; right forward when s<0.
      const lForward = s;
      const rForward = -s;
      const lKnee = Math.max(0, -c); // bend more when swinging backward
      const rKnee = Math.max(0, c);

      // Upper legs pitch + slight outward roll for style.
      tmpEuler.set(stride * lForward * 0.75, 0, stride * 0.08);
      applyLocalRotation(bones.leftUpperLeg, tmpEuler, weight, dt, 20);
      tmpEuler.set(stride * rForward * 0.75, 0, -stride * 0.08);
      applyLocalRotation(bones.rightUpperLeg, tmpEuler, weight, dt, 20);

      // Knees: bend when the leg is behind, plus a tiny always-on bend to avoid locked knees.
      tmpEuler.set(stride * (0.18 + lKnee * 0.75), 0, 0);
      applyLocalRotation(bones.leftLowerLeg, tmpEuler, weight, dt, 20);
      tmpEuler.set(stride * (0.18 + rKnee * 0.75), 0, 0);
      applyLocalRotation(bones.rightLowerLeg, tmpEuler, weight, dt, 20);

      // Feet: keep them flatter, add a touch of toe lift on forward swing.
      tmpEuler.set(-stride * lForward * 0.12 + stride * lKnee * 0.12, 0, 0);
      applyLocalRotation(bones.leftFoot, tmpEuler, weight, dt, 22);
      tmpEuler.set(-stride * rForward * 0.12 + stride * rKnee * 0.12, 0, 0);
      applyLocalRotation(bones.rightFoot, tmpEuler, weight, dt, 22);

      // Arms swing opposite to legs.
      // Baseline arms-down, then add swing.
      const armBaseX = 0.12;
      const armBaseZ = 0.95;
      tmpEuler.set(armBaseX + armSwing * -lForward * 0.45, 0, armBaseZ + armSwing * s2 * 0.08);
      applyLocalRotation(bones.leftUpperArm, tmpEuler, weight, dt, 18);
      tmpEuler.set(armBaseX + armSwing * -rForward * 0.45, 0, -armBaseZ - armSwing * s2 * 0.08);
      applyLocalRotation(bones.rightUpperArm, tmpEuler, weight, dt, 18);

      // Lower arms: mild counter bend.
      tmpEuler.set(-0.18, 0, 0.03);
      applyLocalRotation(bones.leftLowerArm, tmpEuler, weight, dt, 18);
      tmpEuler.set(-0.18, 0, -0.03);
      applyLocalRotation(bones.rightLowerArm, tmpEuler, weight, dt, 18);
    },
    setConfig: (next) => {
      Object.assign(config, next);
      config.enabled = Boolean(config.enabled);
      config.speed = Math.max(0.01, Number(config.speed ?? 1));
      config.stride = clamp01(Number(config.stride ?? 0));
      config.armSwing = clamp01(Number(config.armSwing ?? 0));
      config.bounce = clamp01(Number(config.bounce ?? 0));
      config.lean = clamp01(Number(config.lean ?? 0));
    },
    getConfig: () => ({ ...config })
  };
}
