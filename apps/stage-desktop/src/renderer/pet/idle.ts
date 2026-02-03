import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

export type IdleConfig = {
  enabled: boolean;
  /** Overall blend strength [0..1]. */
  strength: number;
  /** Time scale multiplier. */
  speed: number;
  /** Breathing amount [0..1]. */
  breathe: number;
  /** Sway amount [0..1]. */
  sway: number;
  /** Pose fix: arms-down amount [0..1]. */
  armsDown: number;
  /** Pose fix: slight elbow bend [0..1]. */
  elbowBend: number;
  /** Apply idle even when an animation is playing. */
  overlayOnAnimation: boolean;
};

export type IdleController = {
  apply: (dt: number, t: number, opts?: { hasAnimation?: boolean }) => void;
  setConfig: (next: Partial<IdleConfig>) => void;
  getConfig: () => IdleConfig;
};

const DEFAULT_IDLE_CONFIG: IdleConfig = {
  enabled: true,
  strength: 1,
  speed: 1,
  breathe: 0.55,
  sway: 0.35,
  armsDown: 0.9,
  elbowBend: 0.5,
  overlayOnAnimation: false
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
  | "upperChest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm";

function getNormalizedBoneNode(vrm: VRM, name: BoneName): THREE.Object3D | null {
  const humanoid: any = (vrm as any).humanoid;
  const node = humanoid?.getNormalizedBoneNode?.(name);
  return node && (node as any).isObject3D ? (node as THREE.Object3D) : null;
}

export function createIdleController(vrm: VRM, initial?: Partial<IdleConfig>): IdleController {
  const config: IdleConfig = { ...DEFAULT_IDLE_CONFIG, ...(initial ?? {}) };

  const bones: Partial<Record<BoneName, THREE.Object3D>> = {
    hips: getNormalizedBoneNode(vrm, "hips") ?? undefined,
    spine: getNormalizedBoneNode(vrm, "spine") ?? undefined,
    chest: getNormalizedBoneNode(vrm, "chest") ?? undefined,
    upperChest: getNormalizedBoneNode(vrm, "upperChest") ?? undefined,
    neck: getNormalizedBoneNode(vrm, "neck") ?? undefined,
    head: getNormalizedBoneNode(vrm, "head") ?? undefined,
    leftShoulder: getNormalizedBoneNode(vrm, "leftShoulder") ?? undefined,
    rightShoulder: getNormalizedBoneNode(vrm, "rightShoulder") ?? undefined,
    leftUpperArm: getNormalizedBoneNode(vrm, "leftUpperArm") ?? undefined,
    rightUpperArm: getNormalizedBoneNode(vrm, "rightUpperArm") ?? undefined,
    leftLowerArm: getNormalizedBoneNode(vrm, "leftLowerArm") ?? undefined,
    rightLowerArm: getNormalizedBoneNode(vrm, "rightLowerArm") ?? undefined
  };

  const restQ = new Map<THREE.Object3D, THREE.Quaternion>();
  const restP = new Map<THREE.Object3D, THREE.Vector3>();

  for (const bone of Object.values(bones)) {
    if (!bone) continue;
    restQ.set(bone, bone.quaternion.clone());
    restP.set(bone, bone.position.clone());
  }

  const ARM_SHOULDER_Z = 0.14;
  const ARM_UPPER_Z = 1.12;
  const ARM_LOWER_Z = 0.05;
  const ARM_FORWARD_X = 0.08;

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

    // Blend the offset amount (rest -> rest*offset).
    tmpQ2.copy(rest).slerp(tmpQ1, clamp01(weight));

    // Smoothly converge from current -> target.
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

  function decideArmZSign(opts: {
    label: string;
    shoulder?: THREE.Object3D;
    upper?: THREE.Object3D;
    lower?: THREE.Object3D;
    defaultSign: 1 | -1;
  }): 1 | -1 {
    const upper = opts.upper;
    const lower = opts.lower;
    if (!upper || !lower) return opts.defaultSign;

    const upperRestQ = restQ.get(upper);
    const lowerRestQ = restQ.get(lower);
    if (!upperRestQ || !lowerRestQ) return opts.defaultSign;

    const shoulder = opts.shoulder;
    const shoulderRestQ = shoulder ? restQ.get(shoulder) : null;

    const getDeltaY = () => {
      // `lower.position` is local; world changes based on upper rotation.
      vrm.scene.updateMatrixWorld(true);
      const pu = new THREE.Vector3();
      const pl = new THREE.Vector3();
      upper.getWorldPosition(pu);
      lower.getWorldPosition(pl);
      return pl.y - pu.y;
    };

    const saved = new Map<THREE.Object3D, THREE.Quaternion>();
    const save = (b: THREE.Object3D | undefined) => {
      if (!b) return;
      saved.set(b, b.quaternion.clone());
    };
    const restore = () => {
      for (const [b, q] of saved) b.quaternion.copy(q);
      vrm.scene.updateMatrixWorld(true);
    };

    save(shoulder);
    save(upper);
    save(lower);

    const test = (sign: 1 | -1) => {
      if (shoulder && shoulderRestQ) {
        tmpEuler.set(0, 0, sign * ARM_SHOULDER_Z);
        shoulder.quaternion.copy(shoulderRestQ).multiply(tmpQ2.setFromEuler(tmpEuler));
      }

      tmpEuler.set(ARM_FORWARD_X, 0, sign * ARM_UPPER_Z);
      upper.quaternion.copy(upperRestQ).multiply(tmpQ2.setFromEuler(tmpEuler));

      // Keep lower at rest for measurement.
      lower.quaternion.copy(lowerRestQ);
      return getDeltaY();
    };

    const dyPos = test(1);
    const dyNeg = test(-1);
    restore();

    if (!Number.isFinite(dyPos) || !Number.isFinite(dyNeg)) return opts.defaultSign;
    // We want the elbow to sit lower than the shoulder joint: deltaY should be more negative.
    return dyPos <= dyNeg ? 1 : -1;
  }

  // Auto-detect which Z-rotation direction actually moves the arms downward for this model.
  // Different rigs can have mirrored local axes; this keeps the "armsDown" pose fix stable.
  const leftArmZSign = decideArmZSign({
    label: "left",
    shoulder: bones.leftShoulder,
    upper: bones.leftUpperArm,
    lower: bones.leftLowerArm,
    defaultSign: -1
  });
  const rightArmZSign = decideArmZSign({
    label: "right",
    shoulder: bones.rightShoulder,
    upper: bones.rightUpperArm,
    lower: bones.rightLowerArm,
    defaultSign: 1
  });

  return {
    apply: (dt, t, opts) => {
      if (!config.enabled) return;
      if (opts?.hasAnimation && !config.overlayOnAnimation) return;

      const strength = clamp01(config.strength);
      const speed = Math.max(0.01, Number(config.speed) || 1);
      const breathe = clamp01(config.breathe);
      const sway = clamp01(config.sway);
      const armsDown = clamp01(config.armsDown);
      const elbowBend = clamp01(config.elbowBend);

      const time = t * speed;

      // Smooth overall: keep it responsive but not jittery.
      const smooth = 14;

      // Breathing waves (phase-shifted so chest expands when hips slightly rise).
      const breathA = Math.sin(time * 2.1);
      const breathB = Math.sin(time * 2.1 + 1.2);
      const swayA = Math.sin(time * 0.9);
      const swayB = Math.sin(time * 0.9 + 0.7);

      // Hips: subtle vertical bob + tiny yaw sway.
      tmpEuler.set(breathe * breathB * 0.02, sway * swayA * 0.06, sway * swayB * 0.015);
      applyLocalRotation(bones.hips, tmpEuler, strength, dt, smooth);
      tmpV1.set(0, breathe * breathA * 0.01, 0);
      applyLocalPosition(bones.hips, tmpV1, strength, dt, smooth);

      // Spine: counter-rotate slightly to keep balance.
      tmpEuler.set(-breathe * breathA * 0.025, 0, -sway * swayA * 0.012);
      applyLocalRotation(bones.spine, tmpEuler, strength, dt, smooth);

      // Chest & upperChest: breathing expansion + subtle roll.
      tmpEuler.set(breathe * breathA * 0.05, 0, sway * swayB * 0.02);
      applyLocalRotation(bones.chest, tmpEuler, strength, dt, smooth);
      tmpEuler.set(breathe * breathB * 0.03, 0, sway * swayA * 0.015);
      applyLocalRotation(bones.upperChest, tmpEuler, strength, dt, smooth);

      // Neck / head: micro nod and counter-roll.
      tmpEuler.set(breathe * breathB * 0.012, 0, -sway * swayB * 0.01);
      applyLocalRotation(bones.neck, tmpEuler, strength, dt, smooth);
      tmpEuler.set(breathe * breathA * 0.01, sway * swayA * 0.02, -sway * swayA * 0.01);
      applyLocalRotation(bones.head, tmpEuler, strength, dt, smooth);

      // Arms-down pose fix (brings the avatar closer to a natural standing idle).
      const poseW = strength * armsDown;
      if (poseW > 0) {
        // shoulders a bit down/in
        tmpEuler.set(0, 0, leftArmZSign * ARM_SHOULDER_Z);
        applyLocalRotation(bones.leftShoulder, tmpEuler, poseW, dt, 18);
        tmpEuler.set(0, 0, rightArmZSign * ARM_SHOULDER_Z);
        applyLocalRotation(bones.rightShoulder, tmpEuler, poseW, dt, 18);

        // Upper arms: rotate down (Z) and slightly forward (X)
        tmpEuler.set(ARM_FORWARD_X, 0, leftArmZSign * ARM_UPPER_Z);
        applyLocalRotation(bones.leftUpperArm, tmpEuler, poseW, dt, 18);
        tmpEuler.set(ARM_FORWARD_X, 0, rightArmZSign * ARM_UPPER_Z);
        applyLocalRotation(bones.rightUpperArm, tmpEuler, poseW, dt, 18);

        // Lower arms: small elbow bend
        const bend = poseW * elbowBend;
        tmpEuler.set(-0.32, 0, leftArmZSign * ARM_LOWER_Z);
        applyLocalRotation(bones.leftLowerArm, tmpEuler, bend, dt, 18);
        tmpEuler.set(-0.32, 0, rightArmZSign * ARM_LOWER_Z);
        applyLocalRotation(bones.rightLowerArm, tmpEuler, bend, dt, 18);
      }
    },
    setConfig: (next) => {
      Object.assign(config, next);
      config.enabled = Boolean(config.enabled);
      config.overlayOnAnimation = Boolean(config.overlayOnAnimation);
      config.strength = clamp01(Number(config.strength ?? 1));
      config.speed = Math.max(0.01, Number(config.speed ?? 1));
      config.breathe = clamp01(Number(config.breathe ?? 0));
      config.sway = clamp01(Number(config.sway ?? 0));
      config.armsDown = clamp01(Number(config.armsDown ?? 0));
      config.elbowBend = clamp01(Number(config.elbowBend ?? 0));
    },
    getConfig: () => ({ ...config })
  };
}
