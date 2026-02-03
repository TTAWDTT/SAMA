import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { ActionCommand } from "@sama/shared";
import { loadVrmFromBytes, updateExpressions } from "./vrm";
import { createClipFromVrmAnimation, loadVrmAnimationFromBytes, reanchorPositionTracks } from "./vrma";
import type { IdleConfig, IdleController } from "./idle";
import { createIdleController } from "./idle";
import type { WalkConfig, WalkController } from "./walk";
import { createWalkController } from "./walk";

export type ModelTransform = {
  scale: number;
  yawDeg: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
};

export type VrmAnimationConfig = {
  enabled: boolean;
  paused: boolean;
  speed: number;
};

export type MotionState = {
  locomotion: "IDLE" | "WALK";
  animation: "NONE" | "IDLE" | "WALK" | "ACTION";
};

export type CameraPreset = "full" | "half" | "closeup";

export type PetScene = {
  start: () => void;
  setExpression: (expr: ActionCommand["expression"]) => void;
  loadVrmBytes: (bytes: Uint8Array) => Promise<void>;
  loadVrmAnimationBytes: (bytes: Uint8Array) => Promise<boolean>;
  speak: (durationMs?: number) => void;
  refitCamera: () => void;
  setIdleConfig: (cfg: Partial<IdleConfig>) => void;
  getIdleConfig: () => IdleConfig | null;
  setWalkConfig: (cfg: Partial<WalkConfig>) => void;
  getWalkConfig: () => WalkConfig | null;
  setModelTransform: (t: Partial<ModelTransform>) => void;
  getModelTransform: () => ModelTransform;
  /** Rotate camera orbit around the avatar (right drag). */
  orbitView?: (dx: number, dy: number) => void;
  /** Pan the avatar inside the window (Shift + left drag). */
  panModel?: (dx: number, dy: number) => void;
  setVrmAnimationConfig: (cfg: Partial<VrmAnimationConfig>) => void;
  getVrmAnimationConfig: () => VrmAnimationConfig;
  clearVrmAnimation: () => void;
  setVrmAnimationSlotFromLast: (slot: "idle" | "walk") => boolean;
  clearVrmAnimationSlot: (slot: "idle" | "walk") => void;
  getVrmAnimationSlotsStatus: () => {
    hasLastLoaded: boolean;
    hasIdle: boolean;
    hasWalk: boolean;
    hasAction: boolean;
  };
  notifyAction: (cmd: ActionCommand) => void;
  setDragging: (dragging: boolean) => void;
  notifyDragDelta: (dx: number, dy: number) => void;
  getMotionState: () => MotionState;
  /** Normalized (0..1) anchor position for caption bubbles. */
  getBubbleAnchor?: () => { nx: number; ny: number } | null;
  /** Set camera to a preset view. */
  setCameraPreset?: (preset: CameraPreset) => void;
  /** Get current camera preset. */
  getCameraPreset?: () => CameraPreset;
  /** Take a screenshot and return as data URL. */
  takeScreenshot?: () => string | null;
};

function safeNowMs() {
  // prefer monotonic clock in renderer
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function computeVisibleBounds(root: THREE.Object3D) {
  const box = new THREE.Box3();
  const childBox = new THREE.Box3();

  root.updateMatrixWorld(true);
  root.traverse((obj: any) => {
    if (!obj?.visible) return;
    if (!obj.isMesh) return;
    if (typeof obj.name === "string" && obj.name.startsWith("VRMC_springBone_collider")) return;
    const geom = obj.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return;
    childBox.copy(geom.boundingBox);
    childBox.applyMatrix4(obj.matrixWorld);
    box.union(childBox);
  });

  return box;
}

export async function createPetScene(canvas: HTMLCanvasElement, vrmBytes: Uint8Array): Promise<PetScene> {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

  // View framing + user-adjustable orbit
  const viewTarget = new THREE.Vector3(0, 1.25, 0);
  let viewBaseDistance = 2.2;
  let orbitYaw = 0;
  let orbitPitch = 0;
  let currentCameraPreset: CameraPreset = "full";
  const tmpSpherical = new THREE.Spherical();
  const tmpCamOffset = new THREE.Vector3();
  const tmpCamDir = new THREE.Vector3();
  const tmpCamRight = new THREE.Vector3();
  const tmpCamUp = new THREE.Vector3();
  const tmpPan = new THREE.Vector3();
  const tmpRaycaster = new THREE.Raycaster();
  const tmpNdc = new THREE.Vector2();
  const tmpPlane = new THREE.Plane();
  const tmpRayHit = new THREE.Vector3();
  const tmpBubbleWorld = new THREE.Vector3();
  const tmpBubbleNdc = new THREE.Vector3();
  const tmpFitWorld = new THREE.Vector3();
  const tmpFitWorld2 = new THREE.Vector3();

  const applyView = () => {
    const radius = Math.max(0.35, Number(viewBaseDistance) || 0);
    const pitch = THREE.MathUtils.clamp(Number(orbitPitch) || 0, -1.05, 1.05);
    orbitPitch = pitch;

    // three.js spherical: phi is polar angle from +Y (0..PI), theta is azimuth around Y.
    const phi = THREE.MathUtils.clamp(Math.PI / 2 - pitch, 0.12, Math.PI - 0.12);
    tmpSpherical.set(radius, phi, Number(orbitYaw) || 0);
    tmpCamOffset.setFromSpherical(tmpSpherical);

    camera.position.copy(viewTarget).add(tmpCamOffset);
    camera.lookAt(viewTarget);
  };

  // Camera preset configurations - adjusted for better framing
  // full: show entire body, half: show upper body with waist at bottom, closeup: show head with neck at bottom
  const CAMERA_PRESETS: Record<CameraPreset, { targetY: number; distance: number; pitch: number }> = {
    full: { targetY: 0.9, distance: 2.4, pitch: 0 },
    half: { targetY: 1.0, distance: 1.2, pitch: 0.08 },
    closeup: { targetY: 1.4, distance: 0.6, pitch: 0.1 }
  };

  const applyCameraPreset = (preset: CameraPreset) => {
    const cfg = CAMERA_PRESETS[preset];
    if (!cfg) return;
    currentCameraPreset = preset;

    // Cancel any pending refit that could override our preset values
    if (pendingRefitRaf) {
      cancelAnimationFrame(pendingRefitRaf);
      pendingRefitRaf = 0;
    }

    // Reset ALL user offsets when switching presets
    modelTransform.offsetX = 0;
    modelTransform.offsetY = 0;
    modelTransform.offsetZ = 0;

    // Reset orbit to defaults
    orbitPitch = cfg.pitch;
    orbitYaw = 0;

    // Align model position based on current preset (feet/hips/neck at Y=0)
    fitCameraToModel();

    // Apply fixed framing values for consistent look across all presets
    viewBaseDistance = cfg.distance;

    // Calculate viewTarget.y so alignment point (Y=0) appears at screen bottom
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const halfVisibleHeight = cfg.distance * Math.tan(vFovRad / 2);
    viewTarget.y = halfVisibleHeight;

    applyView();
  };

  camera.position.set(0, 1.25, 2.2);
  applyView();

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 2, 2);
  scene.add(ambient, dir);

  let vrm: VRM | null = null;
  let fallback: THREE.Object3D | null = null;
  const expressionWeights: Record<string, number> = {};
  let expression: ActionCommand["expression"] = "NEUTRAL";
  const pointerTarget = new THREE.Vector3(0, 1.35, 0.6);
  const fixationTarget = new THREE.Vector3().copy(pointerTarget);
  const lookTargetObj = new THREE.Object3D();
  lookTargetObj.position.copy(pointerTarget);
  scene.add(lookTargetObj);
  let eyeBaseY = 1.35;
  let lastPointerMoveAt = safeNowMs();

  // Auto blink (Airi-like)
  let isBlinking = false;
  let blinkProgress = 0;
  let timeSinceLastBlink = 0;
  const BLINK_DURATION_SEC = 0.2;
  const MIN_BLINK_INTERVAL_SEC = 1.0;
  const MAX_BLINK_INTERVAL_SEC = 6.0;
  let nextBlinkAfter = MIN_BLINK_INTERVAL_SEC + Math.random() * (MAX_BLINK_INTERVAL_SEC - MIN_BLINK_INTERVAL_SEC);

  // Idle eye saccades (Airi-like)
  let timeSinceLastSaccade = 0;
  let nextSaccadeAfter = 0.35 + Math.random() * 1.8;

  // Simple "talking" mouth animation (no TTS required)
  let talkingUntil = 0;
  let talkPhase = 0;
  let mouthWeight = 0;

  // VRM animation (.vrma) support (Airi-like)
  let vrmAnimationLastLoaded: any | null = null;
  let vrmAnimationAction: any | null = null;
  let vrmAnimationIdle: any | null = null;
  let vrmAnimationWalk: any | null = null;
  let embeddedIdleClip: THREE.AnimationClip | null = null;
  let embeddedWalkClip: THREE.AnimationClip | null = null;
  let clipCache = new WeakMap<any, THREE.AnimationClip>();
  let mixer: THREE.AnimationMixer | null = null;
  let activeAction: THREE.AnimationAction | null = null;
  let activeClipSource: THREE.AnimationClip | null = null;
  let activeAnimation: MotionState["animation"] = "NONE";
  let locomotion: MotionState["locomotion"] = "IDLE";
  let restHipsLocal: THREE.Vector3 | null = null;

  // Movement signals (to switch idle <-> walk)
  let dragging = false;
  // While dragging (or during short animation transitions), clamp hips Y to avoid
  // visible vertical "popping"/floating caused by VRMA root translation.
  let dragLockHipsY: number | null = null;
  let lockHipsYUntil = 0;
  let lockHipsYValue: number | null = null;
  let lastDragAt = 0;
  let lastDragMag = 0;
  let actionMoveUntil = 0;
  let moveIntensity = 0;
  let wasMoving = false;
  let walkResetUntil = 0;

  // Procedural idle pose/motion (Airi-like fallback when no idle VRMA is provided)
  let idle: IdleController | null = null;
  let idleConfigOverride: Partial<IdleConfig> = {};
  let walk: WalkController | null = null;
  let walkConfigOverride: Partial<WalkConfig> = {};

  const modelTransform: ModelTransform = {
    scale: 1,
    yawDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0
  };
  // originModelPos: position when VRM was first loaded (never changes, used for preset switching)
  const originModelPos = new THREE.Vector3();
  const baseModelPos = new THREE.Vector3();
  const baseModelQuat = new THREE.Quaternion();
  const baseModelScale = new THREE.Vector3(1, 1, 1);
  const tmpModelOffset = new THREE.Vector3();
  const tmpYawQuat = new THREE.Quaternion();
  const tmpModelScale = new THREE.Vector3();

  const vrmAnimationConfig: VrmAnimationConfig = { enabled: true, paused: false, speed: 1 };

  let pendingRefitRaf = 0;
  const requestRefit = () => {
    if (!vrm) return;
    if (pendingRefitRaf) return;
    pendingRefitRaf = requestAnimationFrame(() => {
      pendingRefitRaf = 0;
      fitCameraToModel();
    });
  };

  function resize() {
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(1, clientHeight);
    camera.updateProjectionMatrix();
    requestRefit();
  }

  window.addEventListener("resize", resize);
  resize();

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

    tmpNdc.set(nx, ny);
    tmpRaycaster.setFromCamera(tmpNdc, camera);
    camera.getWorldDirection(tmpCamDir).normalize();
    tmpPlane.setFromNormalAndCoplanarPoint(tmpCamDir, viewTarget);
    if (tmpRaycaster.ray.intersectPlane(tmpPlane, tmpRayHit)) {
      pointerTarget.copy(tmpRayHit);
    } else {
      pointerTarget.copy(viewTarget);
      pointerTarget.y = eyeBaseY;
    }
    fixationTarget.copy(pointerTarget);
    lastPointerMoveAt = safeNowMs();
  });

  const mountFallback = () => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x8be9fd, transparent: true, opacity: 0.85 })
    );
    mesh.position.set(0, 1.2, 0);
    fallback = mesh;
    scene.add(mesh);
  };

  const unmountCurrent = () => {
    if (fallback) {
      scene.remove(fallback);
      fallback = null;
    }
    if (activeAction && mixer) {
      try {
        activeAction.stop();
      } catch {}
      activeAction = null;
    }
    if (mixer && vrm) {
      try {
        mixer.uncacheRoot(vrm.scene);
      } catch {}
    }
    mixer = null;
    idle = null;
    walk = null;
    embeddedIdleClip = null;
    embeddedWalkClip = null;
    clipCache = new WeakMap<any, THREE.AnimationClip>();
    activeAnimation = "NONE";
    locomotion = "IDLE";

    dragging = false;
    lastDragAt = 0;
    lastDragMag = 0;
    actionMoveUntil = 0;
    moveIntensity = 0;
    if (vrm) {
      scene.remove(vrm.scene);
      // VRMUtils.deepDispose exists in three-vrm v2+, but keep it optional
      try {
        (vrm as any).dispose?.();
      } catch {}
      vrm = null;
    }
    restHipsLocal = null;
  };

  const applyModelTransform = () => {
    if (!vrm) return;

    const scale = Math.max(0.05, Number(modelTransform.scale) || 1);
    tmpModelOffset.set(
      Number(modelTransform.offsetX) || 0,
      Number(modelTransform.offsetY) || 0,
      Number(modelTransform.offsetZ) || 0
    );
    tmpYawQuat.setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(Number(modelTransform.yawDeg) || 0), 0));

    vrm.scene.position.copy(baseModelPos).add(tmpModelOffset);
    vrm.scene.quaternion.copy(baseModelQuat).multiply(tmpYawQuat);
    tmpModelScale.copy(baseModelScale).multiplyScalar(scale);
    vrm.scene.scale.copy(tmpModelScale);
  };

  function pickEmbeddedClip(kind: "idle" | "walk", clips: THREE.AnimationClip[]) {
    const keywords =
      kind === "idle" ? ["idle", "stand", "wait", "breath"] : ["walk", "run", "move", "locomotion"];
    for (const clip of clips) {
      const name = (clip?.name ?? "").toLowerCase();
      if (!name) continue;
      if (clip.duration < 0.1) continue;
      if (keywords.some((k) => name.includes(k))) return clip;
    }
    return null;
  }

  const getClipFromVrmAnimation = (anim: any): THREE.AnimationClip | null => {
    if (!vrm || !anim) return null;
    const cached = clipCache.get(anim);
    if (cached) return cached;

    try {
      const clip = createClipFromVrmAnimation(vrm, anim);
      reanchorPositionTracks(clip, vrm, restHipsLocal ?? undefined);
      clipCache.set(anim, clip);
      return clip;
    } catch (err) {
      console.warn("[vrma] create clip failed:", err);
      return null;
    }
  };

  const applyAnimationConfig = (action: THREE.AnimationAction) => {
    action.paused = Boolean(vrmAnimationConfig.paused);
    const speed = Math.max(0, Number(vrmAnimationConfig.speed) || 1);
    try {
      action.setEffectiveTimeScale(speed);
    } catch {
      (action as any).timeScale = speed;
    }
  };

  const getHipsNode = () => {
    if (!vrm) return null;
    const humanoid: any = (vrm as any).humanoid;
    const node =
      humanoid?.getNormalizedBoneNode?.("hips") ??
      humanoid?.getBoneNode?.("hips") ??
      humanoid?.normalizedHumanBones?.hips?.node ??
      null;
    return node && (node as any).isObject3D ? (node as THREE.Object3D) : null;
  };

  const alignClipToCurrentHips = (clip: THREE.AnimationClip) => {
    if (!vrm) return clip;
    const hipsNode = getHipsNode();
    if (!hipsNode) return clip;

    const anchor = hipsNode.position.clone();
    const aligned = clip.clone();
    (aligned as any).__samaAligned = true;
    reanchorPositionTracks(aligned, vrm, anchor);
    return aligned;
  };

  const setActiveClip = (kind: MotionState["animation"], clip: THREE.AnimationClip | null) => {
    if (!vrm) return;

    if (!vrmAnimationConfig.enabled || !clip) {
      if (activeAction) {
        try {
          activeAction.stop();
        } catch {}
      }
      activeAction = null;
      activeClipSource = null;
      activeAnimation = "NONE";
      return;
    }

    if (!mixer) mixer = new THREE.AnimationMixer(vrm.scene);

    if (activeAction && activeAnimation === kind && activeClipSource === clip) {
      applyAnimationConfig(activeAction);
      return;
    }

    const nextClip = alignClipToCurrentHips(clip);
    const nextAction = mixer.clipAction(nextClip);
    nextAction.reset();
    nextAction.enabled = true;
    nextAction.setLoop(THREE.LoopRepeat, Infinity);
    nextAction.play();
    applyAnimationConfig(nextAction);

    if (activeAction && activeAction !== nextAction) {
      // When cross-fading between clips, tiny differences in translation tracks can
      // create a noticeable vertical "bump". Clamp hips Y briefly to keep the
      // avatar feeling anchored to the window.
      try {
        const hipsNode = getHipsNode();
        if (hipsNode) {
          const now = safeNowMs();
          lockHipsYValue = hipsNode.position.y;
          lockHipsYUntil = Math.max(lockHipsYUntil, now + 260);
        }
      } catch {}

      const prevAction = activeAction;
      const prevClip = typeof prevAction.getClip === "function" ? prevAction.getClip() : null;
      try {
        activeAction.crossFadeTo(nextAction, 0.22, false);
      } catch {
        try {
          prevAction.stop();
        } catch {}
      }
      if (prevClip && (prevClip as any).__samaAligned) {
        setTimeout(() => {
          try {
            prevAction.stop();
          } catch {}
          try {
            mixer?.uncacheAction(prevClip, vrm?.scene);
          } catch {}
        }, 320);
      }
    }

    activeAction = nextAction;
    activeClipSource = clip;
    activeAnimation = kind;
  };

  const syncAnimationForMovement = (
    nowMs: number,
    moving: { moving: boolean; actionMoving: boolean; dragMoving: boolean }
  ) => {
    if (!vrmAnimationConfig.enabled) {
      setActiveClip("NONE", null);
      return;
    }

    // 1) Manual override action (explicitly loaded)
    if (vrmAnimationAction) {
      const clip = getClipFromVrmAnimation(vrmAnimationAction);
      if (clip) {
        setActiveClip("ACTION", clip);
        return;
      }
    }

    // 2) Locomotion loops (idle/walk) if user assigned them
    if (moving.moving) {
      const vrma = vrmAnimationWalk ? getClipFromVrmAnimation(vrmAnimationWalk) : null;
      if (vrma) {
        setActiveClip("WALK", vrma);
        return;
      }
      if (embeddedWalkClip) {
        setActiveClip("WALK", embeddedWalkClip);
        return;
      }

      // Dragging without a walk clip: keep idle clip to avoid vertical bobbing.
      if (!moving.actionMoving && moving.dragMoving) {
        const idleVrma = vrmAnimationIdle ? getClipFromVrmAnimation(vrmAnimationIdle) : null;
        if (idleVrma) {
          setActiveClip("IDLE", idleVrma);
          return;
        }
        if (embeddedIdleClip) {
          setActiveClip("IDLE", embeddedIdleClip);
          return;
        }
      }
    } else {
      const vrma = vrmAnimationIdle ? getClipFromVrmAnimation(vrmAnimationIdle) : null;
      if (vrma) {
        setActiveClip("IDLE", vrma);
        return;
      }
      if (embeddedIdleClip) {
        setActiveClip("IDLE", embeddedIdleClip);
        return;
      }
    }

    // 3) No clip available -> procedural only
    setActiveClip("NONE", null);
  };

  const fitCameraToModel = () => {
    if (!vrm) return;

    // IMPORTANT: Start from ORIGIN position to avoid accumulated offsets when switching presets
    vrm.scene.position.copy(originModelPos);
    vrm.scene.quaternion.copy(baseModelQuat);
    vrm.scene.scale.copy(baseModelScale);

    const box = computeVisibleBounds(vrm.scene);
    if (box.isEmpty()) return;

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Get bone positions for alignment
    let anchorX = center.x;
    let anchorZ = center.z;
    let groundY = box.min.y;
    let hipsY = center.y;
    let headY = box.max.y;
    let neckY = center.y + size.y * 0.3; // Estimate neck position

    try {
      const humanoid: any = (vrm as any).humanoid;
      const getNode = (name: string) =>
        humanoid?.getNormalizedBoneNode?.(name) ??
        humanoid?.getBoneNode?.(name) ??
        humanoid?.normalizedHumanBones?.[name]?.node ??
        null;

      const hips = getNode("hips");
      if (hips && typeof hips.getWorldPosition === "function") {
        hips.getWorldPosition(tmpFitWorld);
        anchorX = tmpFitWorld.x;
        anchorZ = tmpFitWorld.z;
        hipsY = tmpFitWorld.y;
      }

      const head = getNode("head");
      if (head && typeof head.getWorldPosition === "function") {
        head.getWorldPosition(tmpFitWorld);
        headY = tmpFitWorld.y;
      }

      const neck = getNode("neck");
      if (neck && typeof neck.getWorldPosition === "function") {
        neck.getWorldPosition(tmpFitWorld);
        neckY = tmpFitWorld.y;
      }

      const lFoot = getNode("leftFoot");
      const rFoot = getNode("rightFoot");
      const footYs: number[] = [];
      if (lFoot && typeof lFoot.getWorldPosition === "function") {
        lFoot.getWorldPosition(tmpFitWorld);
        if (Number.isFinite(tmpFitWorld.y)) footYs.push(tmpFitWorld.y);
      }
      if (rFoot && typeof rFoot.getWorldPosition === "function") {
        rFoot.getWorldPosition(tmpFitWorld2);
        if (Number.isFinite(tmpFitWorld2.y)) footYs.push(tmpFitWorld2.y);
      }
      if (footYs.length) {
        const footY = Math.min(...footYs);
        const diff = footY - box.min.y;
        const threshold = Math.max(0.03, size.y * 0.06);
        if (diff > threshold) {
          groundY = footY - Math.max(0.015, size.y * 0.03);
        }
      }
    } catch {}

    const scale = Math.max(0.05, Number(modelTransform.scale) || 1);
    const scaledHeight = size.y * scale;

    // Calculate alignment based on current preset
    let alignY: number;
    let visibleTop: number;
    let visibleBottom: number;

    if (currentCameraPreset === "closeup") {
      // Closeup: align neck to bottom, show head area
      alignY = neckY;
      visibleBottom = neckY;
      visibleTop = box.max.y + (box.max.y - headY) * 0.2; // Add space above head
    } else if (currentCameraPreset === "half") {
      // Half body: align hips to bottom, show from hips to above head
      alignY = hipsY;
      visibleBottom = hipsY;
      visibleTop = box.max.y + (box.max.y - headY) * 0.15;
    } else {
      // Full body: align feet to bottom, show entire body
      alignY = groundY;
      visibleBottom = groundY;
      visibleTop = box.max.y;
    }

    const dx = -anchorX;
    const dy = -alignY;
    const dz = -anchorZ;
    vrm.scene.position.x += dx;
    vrm.scene.position.y += dy;
    vrm.scene.position.z += dz;

    // Eye height heuristic
    eyeBaseY = Math.max(0.6, scaledHeight * 0.78);
    pointerTarget.y = eyeBaseY;
    fixationTarget.y = eyeBaseY;
    lookTargetObj.position.y = eyeBaseY;

    // Calculate visible range after translation
    const visibleHeight = (visibleTop - visibleBottom) * scale;
    const minX = (box.min.x + dx) * scale;
    const maxX = (box.max.x + dx) * scale;

    // Frame the avatar - MUST fill either width or height completely
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const vTan = Math.max(0.0001, Math.tan(vFovRad / 2));
    const hFovRad = 2 * Math.atan(vTan * camera.aspect);
    const hTan = Math.max(0.0001, Math.tan(hFovRad / 2));

    // Minimal margins - SAMA should fill the frame
    const MARGIN = 0.01;

    // Calculate distances needed to fit width and height
    const halfW = Math.max(0.1, Math.max(Math.abs(minX), Math.abs(maxX)));
    const distW = halfW / (hTan * (1 - MARGIN));
    const distH = (visibleHeight / 2) / (vTan * (1 - MARGIN));

    // Use the LARGER distance so SAMA fills both dimensions completely (contain)
    const radius = Math.max(0.5, Math.max(distH, distW));

    // Position camera target at center of visible range
    const targetY = visibleHeight / 2;
    viewTarget.set(0, Math.max(0.1, targetY), 0);
    viewBaseDistance = radius;

    // Apply preset-specific pitch adjustments
    if (currentCameraPreset === "closeup") {
      orbitPitch = 0.12;
    } else if (currentCameraPreset === "half") {
      orbitPitch = 0.08;
    } else {
      orbitPitch = 0;
    }

    applyView();

    baseModelPos.copy(vrm.scene.position);
    baseModelQuat.copy(vrm.scene.quaternion);
    applyModelTransform();
  };

  const computeBubbleAnchor = (): { nx: number; ny: number } | null => {
    if (!vrm) return null;

    const humanoid: any = (vrm as any).humanoid;
    const headNode =
      humanoid?.getNormalizedBoneNode?.("head") ??
      humanoid?.getBoneNode?.("head") ??
      humanoid?.normalizedHumanBones?.head?.node ??
      null;

    if (headNode && typeof headNode.getWorldPosition === "function") {
      headNode.getWorldPosition(tmpBubbleWorld);
      // Nudge slightly upward so the bubble sits above the head, not on the forehead.
      tmpBubbleWorld.y += 0.08;
    } else {
      tmpBubbleWorld.copy(viewTarget);
      tmpBubbleWorld.y += 0.2;
    }

    tmpBubbleNdc.copy(tmpBubbleWorld).project(camera);
    const nx = (tmpBubbleNdc.x + 1) / 2;
    const ny = (-tmpBubbleNdc.y + 1) / 2;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;

    return {
      nx: THREE.MathUtils.clamp(nx, 0.04, 0.96),
      ny: THREE.MathUtils.clamp(ny, 0.04, 0.96)
    };
  };

  const load = async (bytes: Uint8Array) => {
    unmountCurrent();
    const next = await loadVrmFromBytes(bytes);
    if (!next) {
      mountFallback();
      return;
    }

    vrm = next.vrm;

    // Capture a stable local hips position from the rest pose. We'll use it to reanchor VRMA translation tracks,
    // so importing / switching animations doesn't cause the avatar to float up/down depending on load timing.
    try {
      const hipsNode = (vrm as any).humanoid?.getNormalizedBoneNode?.("hips");
      restHipsLocal = hipsNode && (hipsNode as any).isObject3D ? (hipsNode as THREE.Object3D).position.clone() : null;
    } catch {
      restHipsLocal = null;
    }
    const embeddedClips = Array.isArray(next.animations) ? next.animations : [];
    embeddedIdleClip = pickEmbeddedClip("idle", embeddedClips);
    embeddedWalkClip = pickEmbeddedClip("walk", embeddedClips);
    clipCache = new WeakMap<any, THREE.AnimationClip>();

    (vrm.scene as any).traverse?.((obj: any) => {
      if (obj.isMesh) obj.frustumCulled = false;
    });
    scene.add(vrm.scene);
    if (vrm.lookAt) {
      (vrm.lookAt as any).target = lookTargetObj;
    }

    // Save ORIGIN position (never changes, used for preset switching)
    originModelPos.copy(vrm.scene.position);
    baseModelPos.copy(vrm.scene.position);
    baseModelQuat.copy(vrm.scene.quaternion);
    baseModelScale.copy(vrm.scene.scale);

    idle = createIdleController(vrm, idleConfigOverride);
    walk = createWalkController(vrm, walkConfigOverride);

    fitCameraToModel();
    syncAnimationForMovement(safeNowMs(), { moving: false, actionMoving: false, dragMoving: false });
  };

  await load(vrmBytes);

  const clock = new THREE.Clock();
  let running = false;

  const computeMovementState = (now: number) => {
    const actionMoving = now < actionMoveUntil;
    const dragMoving = dragging && now - lastDragAt < 140;

    // UX choice: manual window dragging is primarily for repositioning the pet,
    // not for "showing off" a walk cycle. Some VRMA idle/walk clips contain
    // vertical translation that looks like the avatar is floating while the user drags.
    // We therefore treat drag-moving as "not moving" for animation selection.
    //
    // NOTE: Approach/retreat is still treated as movement and can trigger WALK.
    const movingForAnim = actionMoving;
    return { moving: movingForAnim, actionMoving, dragMoving };
  };

  function tick() {
    if (!running) return;
    requestAnimationFrame(tick);
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    if (vrm) {
      const now = safeNowMs();

      // Movement detection: window moving (APPROACH/RETREAT) or user dragging -> switch to WALK.
      const movement = computeMovementState(now);
      locomotion = movement.moving ? "WALK" : "IDLE";

      const dragIntensity = movement.dragMoving ? Math.min(1, lastDragMag / 22) : 0;
      const targetIntensity = movement.actionMoving ? 1 : dragIntensity;
      moveIntensity = THREE.MathUtils.lerp(moveIntensity, targetIntensity, 1 - Math.exp(-14 * dt));

      syncAnimationForMovement(now, movement);

      // When a short movement stops, keep ticking the walk controller briefly at zero intensity
      // so legs/hips can converge back to rest (prevents ending up "floating").
      if (wasMoving && !movement.moving) walkResetUntil = now + 900;
      wasMoving = movement.moving;

      if (mixer) {
        try {
          mixer.update(dt);
        } catch {}
      }

      // Procedural locomotion when no VRMA/embedded clip is available.
      if (activeAnimation === "NONE") {
        if (movement.moving) {
          walk?.apply(dt, t, { intensity: moveIntensity });
        } else {
          if (now < walkResetUntil) walk?.apply(dt, t, { intensity: 0 });
          idle?.apply(dt, t, { hasAnimation: false });
        }
      } else {
        // Overlay procedural idle only if user enables it (see idle.overlayOnAnimation).
        idle?.apply(dt, t, { hasAnimation: true });
      }

      // Clamp hips Y while dragging or during a short transition window.
      try {
        const hipsNode = getHipsNode();
        if (hipsNode) {
          if (dragging && dragLockHipsY !== null) {
            hipsNode.position.y = dragLockHipsY;
          } else if (lockHipsYValue !== null) {
            if (now < lockHipsYUntil) hipsNode.position.y = lockHipsYValue;
            else lockHipsYValue = null;
          }
        }
      } catch {}

      // Expressions and eye targets should be set BEFORE vrm.update() so the update applies them immediately.
      updateExpressions(vrm, expressionWeights, expression as any);

      // Auto blink
      timeSinceLastBlink += dt;
      if (!isBlinking && timeSinceLastBlink >= nextBlinkAfter) {
        isBlinking = true;
        blinkProgress = 0;
      }
      if (isBlinking) {
        blinkProgress += dt / BLINK_DURATION_SEC;
        const k = Math.min(1, Math.max(0, blinkProgress));
        const blinkValue = Math.sin(Math.PI * k);
        const em: any = (vrm as any).expressionManager;
        em?.setValue?.("blink", blinkValue);
        em?.setValue?.("blinkLeft", blinkValue);
        em?.setValue?.("blinkRight", blinkValue);
        if (blinkProgress >= 1) {
          isBlinking = false;
          timeSinceLastBlink = 0;
          em?.setValue?.("blink", 0);
          em?.setValue?.("blinkLeft", 0);
          em?.setValue?.("blinkRight", 0);
          nextBlinkAfter =
            MIN_BLINK_INTERVAL_SEC + Math.random() * (MAX_BLINK_INTERVAL_SEC - MIN_BLINK_INTERVAL_SEC);
        }
      }

      // Idle eye saccades: small random fixation shifts when pointer is not moving
      const pointerIdle = now - lastPointerMoveAt > 700;
      timeSinceLastSaccade += dt;
      if (pointerIdle && timeSinceLastSaccade >= nextSaccadeAfter) {
        fixationTarget.set(
          pointerTarget.x + THREE.MathUtils.randFloat(-0.18, 0.18),
          pointerTarget.y + THREE.MathUtils.randFloat(-0.12, 0.12),
          pointerTarget.z
        );
        timeSinceLastSaccade = 0;
        nextSaccadeAfter = 0.35 + Math.random() * 1.8;
      } else if (!pointerIdle) {
        fixationTarget.copy(pointerTarget);
        timeSinceLastSaccade = 0;
      }
      const eyeLerp = 1 - Math.exp(-10 * dt);
      lookTargetObj.position.lerp(fixationTarget, eyeLerp);

      // Talking mouth (simple viseme-ish)
      if (talkingUntil > now) {
        talkPhase += dt * 14;
        const target = (Math.sin(talkPhase) * 0.5 + 0.5) * 0.8;
        mouthWeight = THREE.MathUtils.lerp(mouthWeight, target, 1 - Math.exp(-18 * dt));
      } else {
        mouthWeight = THREE.MathUtils.lerp(mouthWeight, 0, 1 - Math.exp(-12 * dt));
      }
      const em: any = (vrm as any).expressionManager;
      em?.setValue?.("aa", mouthWeight);

      // Update VRM internal springs / constraints
      vrm.update(dt);
    }

    renderer.render(scene, camera);
  }

  return {
    start: () => {
      if (running) return;
      running = true;
      tick();
    },
    setExpression: (expr) => {
      expression = expr;
    },
    loadVrmBytes: load,
    loadVrmAnimationBytes: async (bytes) => {
      if (!bytes.byteLength) {
        vrmAnimationLastLoaded = null;
        vrmAnimationAction = null;
        const now = safeNowMs();
        syncAnimationForMovement(now, computeMovementState(now));
        return false;
      }

      try {
        vrmAnimationLastLoaded = await loadVrmAnimationFromBytes(bytes);
        vrmAnimationAction = vrmAnimationLastLoaded;
      } catch (err) {
        console.warn("[vrma] load failed:", err);
        vrmAnimationLastLoaded = null;
        vrmAnimationAction = null;
      }
      const now = safeNowMs();
      syncAnimationForMovement(now, computeMovementState(now));
      return !!vrmAnimationLastLoaded;
    },
    speak: (durationMs) => {
      const ms = Math.max(120, Number(durationMs ?? 1200));
      talkingUntil = safeNowMs() + ms;
    },
    refitCamera: () => {
      // Explicit user action (Controls "重置视角/居中") should reset the orbit and pan back to defaults.
      orbitYaw = 0;
      orbitPitch = 0;
      modelTransform.offsetX = 0;
      modelTransform.offsetY = 0;
      modelTransform.offsetZ = 0;
      fitCameraToModel();
    },
    setIdleConfig: (cfg) => {
      idleConfigOverride = { ...idleConfigOverride, ...cfg };
      idle?.setConfig(cfg);
    },
    getIdleConfig: () => idle?.getConfig() ?? null,
    setWalkConfig: (cfg) => {
      walkConfigOverride = { ...walkConfigOverride, ...cfg };
      walk?.setConfig(cfg);
    },
    getWalkConfig: () => walk?.getConfig() ?? null,
    setModelTransform: (t) => {
      const prevScale = modelTransform.scale;

      if (t.scale !== undefined) modelTransform.scale = Math.max(0.05, Number(t.scale) || 1);
      if (t.yawDeg !== undefined) modelTransform.yawDeg = Math.max(-180, Math.min(180, Number(t.yawDeg) || 0));
      if (t.offsetX !== undefined) modelTransform.offsetX = Math.max(-2, Math.min(2, Number(t.offsetX) || 0));
      if (t.offsetY !== undefined) modelTransform.offsetY = Math.max(-2, Math.min(2, Number(t.offsetY) || 0));
      if (t.offsetZ !== undefined) modelTransform.offsetZ = Math.max(-2, Math.min(2, Number(t.offsetZ) || 0));

      // Scale affects camera framing and eye height heuristics. Refit to keep it comfortable.
      if (vrm && modelTransform.scale !== prevScale) fitCameraToModel();
      else applyModelTransform();
    },
    getModelTransform: () => ({ ...modelTransform }),
    orbitView: (dx, dy) => {
      const sx = Number(dx) || 0;
      const sy = Number(dy) || 0;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;

      const sens = 0.005;
      orbitYaw -= sx * sens;
      // Invert vertical drag direction to match user expectation:
      // dragging up should tilt the view upward (rather than down).
      orbitPitch += sy * sens;
      applyView();
    },
    panModel: (dx, dy) => {
      if (!vrm) return;
      const sx = Number(dx) || 0;
      const sy = Number(dy) || 0;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;

      const radius = Math.max(0.35, camera.position.distanceTo(viewTarget));
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      const pxToWorld = (2 * radius * Math.tan(fovRad / 2)) / Math.max(1, canvas.clientHeight);

      tmpCamRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      tmpCamUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

      tmpPan.set(0, 0, 0);
      tmpPan.addScaledVector(tmpCamRight, sx * pxToWorld);
      tmpPan.addScaledVector(tmpCamUp, -sy * pxToWorld);

      modelTransform.offsetX = Math.max(-2, Math.min(2, (Number(modelTransform.offsetX) || 0) + tmpPan.x));
      modelTransform.offsetY = Math.max(-2, Math.min(2, (Number(modelTransform.offsetY) || 0) + tmpPan.y));
      modelTransform.offsetZ = Math.max(-2, Math.min(2, (Number(modelTransform.offsetZ) || 0) + tmpPan.z));
      applyModelTransform();
    },
    setVrmAnimationConfig: (cfg) => {
      if (cfg.enabled !== undefined) vrmAnimationConfig.enabled = Boolean(cfg.enabled);
      if (cfg.paused !== undefined) vrmAnimationConfig.paused = Boolean(cfg.paused);
      if (cfg.speed !== undefined) vrmAnimationConfig.speed = Math.max(0, Number(cfg.speed) || 0);

      if (!vrmAnimationConfig.enabled) {
        setActiveClip("NONE", null);
        return;
      }

      if (activeAction) applyAnimationConfig(activeAction);
      const now = safeNowMs();
      syncAnimationForMovement(now, computeMovementState(now));
    },
    getVrmAnimationConfig: () => ({ ...vrmAnimationConfig }),
    clearVrmAnimation: () => {
      // Stop the manual override action, but keep idle/walk slots.
      vrmAnimationAction = null;
      if (activeAnimation === "ACTION") setActiveClip("NONE", null);
      const now = safeNowMs();
      syncAnimationForMovement(now, computeMovementState(now));
    },
    setVrmAnimationSlotFromLast: (slot) => {
      if (!vrmAnimationLastLoaded) return false;
      if (slot === "idle") vrmAnimationIdle = vrmAnimationLastLoaded;
      else vrmAnimationWalk = vrmAnimationLastLoaded;

      // After promoting to a locomotion slot, exit manual override so auto-switch works.
      vrmAnimationAction = null;
      const now = safeNowMs();
      syncAnimationForMovement(now, computeMovementState(now));
      return true;
    },
    clearVrmAnimationSlot: (slot) => {
      if (slot === "idle") vrmAnimationIdle = null;
      else vrmAnimationWalk = null;
      const now = safeNowMs();
      syncAnimationForMovement(now, computeMovementState(now));
    },
    getVrmAnimationSlotsStatus: () => ({
      hasLastLoaded: !!vrmAnimationLastLoaded,
      hasIdle: !!vrmAnimationIdle,
      hasWalk: !!vrmAnimationWalk,
      hasAction: !!vrmAnimationAction
    }),
    notifyAction: (cmd) => {
      if (cmd.action === "APPROACH" || cmd.action === "RETREAT") {
        const ms = Math.max(100, Number(cmd.durationMs ?? 1500));
        actionMoveUntil = safeNowMs() + ms;
      }
    },
    setDragging: (v) => {
      const next = Boolean(v);
      if (next === dragging) return;
      dragging = next;
      if (dragging) {
        // Remember the current hips height and keep it stable while dragging.
        try {
          const hipsNode = getHipsNode();
          dragLockHipsY = hipsNode ? hipsNode.position.y : null;
        } catch {
          dragLockHipsY = null;
        }
      } else {
        lastDragMag = 0;
        dragLockHipsY = null;
      }
    },
    notifyDragDelta: (dx, dy) => {
      lastDragAt = safeNowMs();
      lastDragMag = Math.hypot(Number(dx) || 0, Number(dy) || 0);
    },
    getMotionState: () => ({ locomotion, animation: activeAnimation }),
    getBubbleAnchor: () => computeBubbleAnchor(),
    setCameraPreset: (preset) => {
      applyCameraPreset(preset);
    },
    getCameraPreset: () => currentCameraPreset,
    takeScreenshot: () => {
      try {
        // Render one frame to ensure we capture current state
        renderer.render(scene, camera);
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    }
  };
}
