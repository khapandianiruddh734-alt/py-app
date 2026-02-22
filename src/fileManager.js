const DB_NAME = "docuextract_file_db";
const DB_VERSION = 1;
const STORE_NAME = "files";
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const IMAGE_MAX_DIMENSION = 1800;
const IMAGE_QUALITY = 0.82;

let dbPromise = null;
const memoryFallback = new Map();

function supportsIndexedDB() {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function supportsCanvas() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

function getNow() {
  return Date.now();
}

function buildId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRecord(record) {
  return {
    id: record.id ?? buildId(),
    userId: String(record.userId ?? "guest"),
    name: String(record.name ?? ""),
    type: String(record.type ?? ""),
    size: Number(record.size ?? 0),
    lastModified: Number(record.lastModified ?? 0),
    createdAt: Number(record.createdAt ?? getNow()),
    expiresAt: Number(record.expiresAt ?? getNow() + EXPIRY_MS),
    status: String(record.status ?? "queued"),
    retries: Number(record.retries ?? 0),
    base64: String(record.base64 ?? ""),
    resultCount: Number(record.resultCount ?? 0),
    error: String(record.error ?? ""),
    dataSize: Number(record.dataSize ?? 0),
  };
}

function openDB() {
  if (!supportsIndexedDB()) {
    return Promise.resolve(null);
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function runIDB(mode, executor) {
  const db = await openDB();
  if (!db) {
    return executor(null);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    executor(store, resolve, reject);

    tx.onerror = () => reject(tx.error);
  });
}

async function imageToCompressedFile(file) {
  if (!file.type.startsWith("image/") || !supportsCanvas()) {
    return file;
  }

  try {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    const loaded = await new Promise((resolve, reject) => {
      img.onload = () => resolve(true);
      img.onerror = reject;
      img.src = objectUrl;
    });
    if (!loaded) {
      URL.revokeObjectURL(objectUrl);
      return file;
    }

    const { width, height } = img;
    const largest = Math.max(width, height);
    if (largest <= IMAGE_MAX_DIMENSION) {
      URL.revokeObjectURL(objectUrl);
      return file;
    }

    const scale = IMAGE_MAX_DIMENSION / largest;
    const targetW = Math.round(width * scale);
    const targetH = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(objectUrl);
      return file;
    }

    ctx.drawImage(img, 0, 0, targetW, targetH);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", IMAGE_QUALITY);
    });
    URL.revokeObjectURL(objectUrl);

    if (!blob) {
      return file;
    }

    return new File([blob], file.name, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

export async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function initializeFileManager() {
  try {
    await openDB();
    await cleanupExpiredFiles();
    return { indexedDB: supportsIndexedDB(), fallback: false };
  } catch {
    return { indexedDB: false, fallback: true };
  }
}

export async function saveFileForUser(userId, file, options = {}) {
  const optimized = await imageToCompressedFile(file);
  const base64 = await fileToBase64(optimized);
  const record = normalizeRecord({
    id: buildId(),
    userId,
    name: optimized.name,
    type: optimized.type,
    size: optimized.size,
    lastModified: optimized.lastModified,
    createdAt: getNow(),
    expiresAt: getNow() + EXPIRY_MS,
    status: options.status ?? "queued",
    retries: options.retries ?? 0,
    base64,
    resultCount: options.resultCount ?? 0,
    error: options.error ?? "",
    dataSize: Math.ceil((base64.length * 3) / 4),
  });

  if (!supportsIndexedDB()) {
    memoryFallback.set(record.id, record);
    return record;
  }

  await runIDB("readwrite", (store, resolve) => {
    store.put(record);
    resolve(record);
  });
  return record;
}

export async function updateFileRecord(id, updates = {}) {
  if (!supportsIndexedDB()) {
    const existing = memoryFallback.get(id);
    if (!existing) return null;
    const merged = normalizeRecord({ ...existing, ...updates });
    memoryFallback.set(id, merged);
    return merged;
  }

  return runIDB("readwrite", (store, resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const current = getReq.result;
      if (!current) {
        resolve(null);
        return;
      }
      const merged = normalizeRecord({ ...current, ...updates });
      store.put(merged);
      resolve(merged);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteFileRecord(id) {
  if (!supportsIndexedDB()) {
    return memoryFallback.delete(id);
  }

  return runIDB("readwrite", (store, resolve) => {
    store.delete(id);
    resolve(true);
  });
}

async function getAllRecords() {
  if (!supportsIndexedDB()) {
    return Array.from(memoryFallback.values());
  }

  return runIDB("readonly", (store, resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function cleanupExpiredFiles() {
  const now = getNow();
  const records = await getAllRecords();
  const expired = records.filter((rec) => Number(rec.expiresAt || 0) <= now);
  if (!expired.length) {
    return 0;
  }

  if (!supportsIndexedDB()) {
    expired.forEach((rec) => memoryFallback.delete(rec.id));
    return expired.length;
  }

  await runIDB("readwrite", (store, resolve) => {
    expired.forEach((rec) => store.delete(rec.id));
    resolve(true);
  });
  return expired.length;
}

export async function getUserFiles(userId) {
  const now = getNow();
  const records = await getAllRecords();
  return records
    .filter((rec) => rec.userId === userId && rec.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getUserFileCount(userId) {
  const rows = await getUserFiles(userId);
  return rows.length;
}

export async function getTeamFileCount() {
  const now = getNow();
  const rows = await getAllRecords();
  return rows.filter((rec) => rec.expiresAt > now).length;
}

export async function checkUserLimit(userId, incomingCount, maxFiles = 10) {
  const existing = await getUserFileCount(userId);
  const available = Math.max(0, maxFiles - existing);
  const accepted = Math.max(0, Math.min(available, incomingCount));
  return {
    maxFiles,
    existing,
    available,
    accepted,
    rejected: Math.max(0, incomingCount - accepted),
    isFull: available <= 0,
  };
}

export async function getStoredBytesUsed() {
  const now = getNow();
  const rows = await getAllRecords();
  return rows
    .filter((rec) => rec.expiresAt > now)
    .reduce((sum, rec) => sum + Number(rec.dataSize || 0), 0);
}

export function decodeBase64ToFile(base64, name, type) {
  const [meta, payload] = String(base64 || "").split(",");
  const mimeType = type || (meta?.match(/data:(.*);base64/)?.[1] ?? "application/octet-stream");
  const binary = atob(payload || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], name || "file", { type: mimeType });
}

