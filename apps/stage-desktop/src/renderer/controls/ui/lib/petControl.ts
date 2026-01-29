import type { PetControlMessage, PetControlResult } from "@sama/shared";
import type { StageDesktopApi } from "../api";
import { clamp } from "./utils";

const pendingPetResults = new Map<string, { resolve: (r: PetControlResult) => void; reject: (e: unknown) => void }>();
let petResultListenerInstalled = false;

function createReqId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function installPetResultListener(api: StageDesktopApi | null) {
  if (petResultListenerInstalled) return;
  if (!api || typeof api.onPetControlResult !== "function") return;

  petResultListenerInstalled = true;
  api.onPetControlResult((res: PetControlResult) => {
    const pending = pendingPetResults.get(res.requestId);
    if (!pending) return;
    pendingPetResults.delete(res.requestId);
    pending.resolve(res);
  });
}

export function sendPetControl(api: StageDesktopApi | null, msg: PetControlMessage) {
  if (!api || typeof api.sendPetControl !== "function") return false;
  try {
    api.sendPetControl(msg);
    return true;
  } catch {
    return false;
  }
}

export function sendPetControlWithResult(
  api: StageDesktopApi | null,
  msg: PetControlMessage,
  opts?: { timeoutMs?: number }
): Promise<PetControlResult> {
  installPetResultListener(api);
  const timeoutMs = clamp(Number(opts?.timeoutMs ?? 12_000), 800, 30_000);

  const requestId = (msg as any).requestId ? String((msg as any).requestId) : createReqId();
  (msg as any).requestId = requestId;

  return new Promise((resolve, reject) => {
    const ok = sendPetControl(api, msg);
    if (!ok) {
      reject(new Error("preload API missing"));
      return;
    }

    let timer: number | null = null;
    const done = (fn: (v: any) => void, v: any) => {
      if (timer !== null) window.clearTimeout(timer);
      pendingPetResults.delete(requestId);
      fn(v);
    };

    pendingPetResults.set(requestId, { resolve: (r) => done(resolve, r), reject: (e) => done(reject, e) });
    timer = window.setTimeout(() => {
      done(reject, new Error("Pet no response: timeout"));
    }, timeoutMs);
  });
}

