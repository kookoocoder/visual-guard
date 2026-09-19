/**
 * Keeps at most one heavy WebGPU model resident and evicts on idle / memory pressure
 * so loading NER + HaS together does not thrash the Mac.
 */

const DEFAULT_IDLE_MS = 90_000;
const PRESSURE_IDLE_MS = 15_000;

/** @type {Map<string, { unload: () => Promise<void>, touch: () => void, lastUsed: number }>} */
const residents = new Map();

let idleTimer = null;
let idleMs = DEFAULT_IDLE_MS;
let listenersBound = false;
/** Serialize loads so NER and HaS never initialize concurrently. */
let loadGate = Promise.resolve();

export function yieldToUi(ms = 0) {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, ms);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(done);
    else done();
  });
}

/** Run async work one-at-a-time (model loads / big downloads). */
export function withLoadLock(fn) {
  const run = loadGate.then(fn, fn);
  loadGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function touchModel(id) {
  const entry = residents.get(id);
  if (!entry) return;
  entry.lastUsed = Date.now();
  entry.touch?.();
  scheduleIdleSweep();
}

export function registerResident(id, { unload }) {
  residents.set(id, {
    unload,
    touch: () => {
      const e = residents.get(id);
      if (e) e.lastUsed = Date.now();
    },
    lastUsed: Date.now(),
  });
  scheduleIdleSweep();
}

export function unregisterResident(id) {
  residents.delete(id);
  if (!residents.size && idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Unload every resident except `keepId` (if provided). */
export async function evictOthers(keepId = null) {
  const jobs = [];
  for (const [id, entry] of [...residents.entries()]) {
    if (keepId && id === keepId) continue;
    residents.delete(id);
    jobs.push(
      Promise.resolve()
        .then(() => entry.unload())
        .catch(() => {}),
    );
  }
  if (jobs.length) await Promise.all(jobs);
  await yieldToUi(0);
  // Hint GC after dropping large GPU/CPU tensors.
  try {
    globalThis.gc?.();
  } catch {
    // not exposed in normal Chrome
  }
}

export async function evictAll() {
  return evictOthers(null);
}

function scheduleIdleSweep() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const now = Date.now();
    const stale = [...residents.entries()].filter(([, e]) => now - e.lastUsed >= idleMs);
    for (const [id, entry] of stale) {
      residents.delete(id);
      Promise.resolve()
        .then(() => entry.unload())
        .catch(() => {});
    }
    if (residents.size) scheduleIdleSweep();
  }, Math.max(5_000, idleMs / 3));
}

function onMemoryPressure(level) {
  idleMs = level === "critical" ? 5_000 : PRESSURE_IDLE_MS;
  if (level === "critical") {
    evictAll().catch(() => {});
  } else {
    // Keep the most recently used model; drop the other.
    let newestId = null;
    let newestAt = 0;
    for (const [id, entry] of residents) {
      if (entry.lastUsed >= newestAt) {
        newestAt = entry.lastUsed;
        newestId = id;
      }
    }
    evictOthers(newestId).catch(() => {});
  }
  scheduleIdleSweep();
}

export function installMemoryListeners() {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      idleMs = PRESSURE_IDLE_MS;
      scheduleIdleSweep();
    } else {
      idleMs = DEFAULT_IDLE_MS;
    }
  });

  window.addEventListener("pagehide", () => {
    evictAll().catch(() => {});
  });

  try {
    if (performance?.memory && "addEventListener" in performance) {
      // Chromium memory-pressure signal when available.
    }
  } catch {
    // ignore
  }

  if (typeof performance !== "undefined" && "measureUserAgentSpecificMemory" in performance) {
    // no continuous polling — too expensive
  }

  // experimental PressureObserver / chrome memory pressure
  try {
    if ("PressureObserver" in window) {
      const observer = new PressureObserver((records) => {
        const last = records[records.length - 1];
        if (last?.state === "critical" || last?.state === "serious") {
          onMemoryPressure(last.state === "critical" ? "critical" : "serious");
        }
      });
      observer.observe("memory", { sampleInterval: 2000 }).catch(() => {});
      observer.observe("cpu", { sampleInterval: 2000 }).catch(() => {});
    }
  } catch {
    // PressureObserver not supported
  }
}

export function setIdleEvictMs(ms) {
  idleMs = Math.max(10_000, Number(ms) || DEFAULT_IDLE_MS);
  scheduleIdleSweep();
}
