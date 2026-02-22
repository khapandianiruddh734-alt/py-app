export function formatBytes(bytes) {
  const safe = Math.max(0, Number(bytes || 0));
  if (safe < 1024) return `${safe} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safe / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[idx]}`;
}

export function createStorageMonitor(options = {}) {
  const warningThreshold = Number(options.warningThreshold ?? 0.8);
  const debounceMs = Number(options.debounceMs ?? 1200);
  const onUpdate = options.onUpdate ?? (() => {});
  const getFallbackUsage = options.getFallbackUsage ?? (async () => 0);
  const onOverThreshold = options.onOverThreshold ?? (async () => {});

  let timeoutId = null;
  let destroyed = false;

  async function estimateStorage() {
    let usage = 0;
    let quota = 0;

    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        usage = Number(estimate?.usage ?? 0);
        quota = Number(estimate?.quota ?? 0);
      }
    } catch {
      // Ignore API failure; fallback below still works.
    }

    if (!usage) {
      usage = Number(await getFallbackUsage());
    }
    if (!quota) {
      quota = Math.max(usage * 2, 50 * 1024 * 1024);
    }

    const percentage = quota > 0 ? usage / quota : 0;
    const warning = percentage >= warningThreshold;

    if (warning) {
      await onOverThreshold();
    }

    const summary = {
      usage,
      quota,
      percentage,
      warning,
      warningThreshold,
      usageLabel: formatBytes(usage),
      quotaLabel: formatBytes(quota),
    };

    onUpdate(summary);
    return summary;
  }

  function schedule() {
    if (destroyed) return;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      void estimateStorage();
    }, debounceMs);
  }

  function stop() {
    destroyed = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  return {
    estimateStorage,
    schedule,
    stop,
  };
}

