import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import type { VRM } from "@pixiv/three-vrm";

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Some exporters (e.g. certain UniGLTF versions) output `VRMC_vrm_animation` without `specVersion`.
 * `@pixiv/three-vrm-animation` requires it, otherwise it ignores the extension entirely.
 *
 * Patch the GLB JSON chunk in-memory to add `specVersion: "1.0"` when missing.
 */
function patchVrmaSpecVersionIfMissing(bytes: Uint8Array): Uint8Array {
  // GLB header (12 bytes) + chunk header (8 bytes)
  if (bytes.byteLength < 20) return bytes;
  if (bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) return bytes; // "glTF"

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonChunkLen = view.getUint32(12, true);
  const type0 = String.fromCharCode(bytes[16], bytes[17], bytes[18], bytes[19]);
  if (type0 !== "JSON") return bytes;

  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonChunkLen;
  if (jsonEnd > bytes.byteLength) return bytes;

  let def: any;
  try {
    const jsonText = new TextDecoder().decode(bytes.slice(jsonStart, jsonEnd));
    def = JSON.parse(jsonText);
  } catch {
    return bytes;
  }

  const ext = def?.extensions?.VRMC_vrm_animation;
  if (!ext || typeof ext !== "object") return bytes;
  if (typeof ext.specVersion === "string" && ext.specVersion) return bytes;

  ext.specVersion = "1.0";
  if (Array.isArray(def.extensionsUsed) && !def.extensionsUsed.includes("VRMC_vrm_animation")) {
    def.extensionsUsed.push("VRMC_vrm_animation");
  }

  const encoded = new TextEncoder().encode(JSON.stringify(def));
  const paddedLen = Math.ceil(encoded.byteLength / 4) * 4;
  const padded = new Uint8Array(paddedLen);
  padded.set(encoded, 0);
  // GLB JSON chunk padding is spaces (0x20)
  padded.fill(0x20, encoded.byteLength);

  const rest = bytes.slice(jsonEnd);
  const out = new Uint8Array(12 + 8 + paddedLen + rest.byteLength);
  out.set(bytes.slice(0, 12), 0);

  const outView = new DataView(out.buffer);
  outView.setUint32(8, out.byteLength, true); // total length
  outView.setUint32(12, paddedLen, true); // JSON chunk length
  out[16] = 0x4a; // J
  out[17] = 0x53; // S
  out[18] = 0x4f; // O
  out[19] = 0x4e; // N
  out.set(padded, 20);
  out.set(rest, 20 + paddedLen);
  return out;
}

export async function loadVrmAnimationFromBytes(bytes: Uint8Array): Promise<VRMAnimation | null> {
  if (!bytes.byteLength) return null;

  const patched = patchVrmaSpecVersionIfMissing(bytes);
  const blob = new Blob([bytesToArrayBuffer(patched)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  try {
    const loader = new GLTFLoader();
    loader.register((parser: any) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrmAnimations = (gltf.userData as any)?.vrmAnimations as VRMAnimation[] | undefined;
    if (!vrmAnimations?.length) return null;
    return vrmAnimations[0] ?? null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createClipFromVrmAnimation(vrm: VRM, animation: VRMAnimation): THREE.AnimationClip {
  // The runtime object is compatible with the VRMCore interface expected by createVRMAnimationClip.
  return createVRMAnimationClip(animation as any, vrm as any);
}

/**
 * Keep the avatar anchored in place by offsetting position tracks so the first hips keyframe matches the current hips.
 * This avoids VRMA clips that "teleport" the model because the clip was authored in a different origin.
 */
export function reanchorPositionTracks(clip: THREE.AnimationClip, vrm: VRM) {
  const hipsNode = (vrm as any).humanoid?.getNormalizedBoneNode?.("hips");
  if (!hipsNode) return;

  hipsNode.updateMatrixWorld(true);
  const currentHipWorld = new THREE.Vector3();
  hipsNode.getWorldPosition(currentHipWorld);

  const hipsTrackName = `${hipsNode.name}.position`;
  const hipsTrack = clip.tracks.find((t) => t instanceof THREE.VectorKeyframeTrack && t.name === hipsTrackName);
  if (!(hipsTrack instanceof THREE.VectorKeyframeTrack)) return;
  if (hipsTrack.values.length < 3) return;

  const first = new THREE.Vector3(hipsTrack.values[0], hipsTrack.values[1], hipsTrack.values[2]);
  const delta = first.sub(currentHipWorld);

  for (const track of clip.tracks) {
    if (!(track instanceof THREE.VectorKeyframeTrack)) continue;
    if (!track.name.endsWith(".position")) continue;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] -= delta.x;
      track.values[i + 1] -= delta.y;
      track.values[i + 2] -= delta.z;
    }
  }
}
