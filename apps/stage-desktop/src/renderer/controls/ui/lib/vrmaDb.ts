import { clamp } from "./utils";

export type VrmaLibraryItem = {
  name: string;
  bytes: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
};

const VRMA_DB_NAME = "sama.vrma.library";
const VRMA_DB_VERSION = 1;
const VRMA_STORE = "vrma";

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export function stripExtension(name: string) {
  return name.replace(/\.[^/.]+$/, "");
}

export function normalizeVrmaName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function openVrmaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VRMA_DB_NAME, VRMA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VRMA_STORE)) {
        db.createObjectStore(VRMA_STORE, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export async function vrmaList(): Promise<VrmaLibraryItem[]> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result as VrmaLibraryItem[]) ?? [];
      items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      resolve(items);
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB getAll failed"));
  });
}

export async function vrmaGet(name: string): Promise<VrmaLibraryItem | null> {
  const db = await openVrmaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readonly");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.get(name);
    req.onsuccess = () => resolve((req.result as VrmaLibraryItem) ?? null);
    req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
  });
}

export async function vrmaPut(item: VrmaLibraryItem): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB put failed"));
  });
}

export async function vrmaDelete(name: string): Promise<void> {
  const db = await openVrmaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VRMA_STORE, "readwrite");
    const store = tx.objectStore(VRMA_STORE);
    const req = store.delete(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("indexedDB delete failed"));
  });
}

export function fmtNum(n: number, digits: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(clamp(digits, 0, 6));
}

