export const MAX_FILES_PER_USER = 50;

export function statusLabel(status) {
  switch (status) {
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

export function statusClass(status) {
  switch (status) {
    case "queued":
      return "dashboard-status dashboard-status-queued";
    case "processing":
      return "dashboard-status dashboard-status-processing";
    case "completed":
      return "dashboard-status dashboard-status-completed";
    case "failed":
      return "dashboard-status dashboard-status-failed";
    default:
      return "dashboard-status";
  }
}

export function resolveCurrentUserId() {
  if (typeof window === "undefined") {
    return "guest";
  }

  const globalUser = window.__APP_USER__;
  if (globalUser?.id) {
    return String(globalUser.id);
  }

  const jsonKeys = ["authUser", "currentUser", "user"];
  for (const key of jsonKeys) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.id) {
        return String(parsed.id);
      }
      if (parsed?.email) {
        return String(parsed.email);
      }
    } catch {
      // Not JSON, continue.
    }
  }

  const plainKeys = ["userId", "uid", "email"];
  for (const key of plainKeys) {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      return String(raw);
    }
  }

  const guestKey = "docuextract_guest_user_id";
  let guestId = window.localStorage.getItem(guestKey);
  if (!guestId) {
    guestId = `guest_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(guestKey, guestId);
  }
  return guestId;
}

export function buildDashboardModel(params) {
  const myFileCount = Number(params.myFileCount ?? 0);
  const teamFileCount = Number(params.teamFileCount ?? 0);
  const queue = params.queue ?? { queued: 0, processing: 0, completed: 0, failed: 0 };
  const maxFiles = Number(params.maxFiles ?? MAX_FILES_PER_USER);
  const storage = params.storage ?? {
    usage: 0,
    quota: 1,
    percentage: 0,
    warning: false,
    usageLabel: "0 B",
    quotaLabel: "0 B",
  };

  return {
    myFileCount,
    maxFiles,
    myFilePct: Math.min(100, Math.round((myFileCount / Math.max(1, maxFiles)) * 100)),
    teamFileCount,
    queue,
    storage,
    storagePct: Math.min(100, Math.round(storage.percentage * 100)),
    isStorageWarning: Boolean(storage.warning),
  };
}

