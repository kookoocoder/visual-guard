const DB_NAME = "visual-guard";
const DB_VERSION = 1;
const STORE = "conversations";
const SESSION_KEY = "visualGuardAgentHistory";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error("Unable to open chat history."));
    };
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Chat history request failed."));
  });
}

export function titleFromMessages(messages) {
  const first = (messages || []).find((message) => message?.role === "user" && typeof message.content === "string");
  const text = String(first?.content || "New chat").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

export function transcriptFromMessages(messages) {
  const items = [];
  for (const message of messages || []) {
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      items.push({ role: "user", text: message.content });
    } else if (message?.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      items.push({ role: "assistant", text: message.content });
    }
  }
  return items;
}

export async function listConversations() {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function putConversation(record) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to save chat history."));
    tx.onabort = () => reject(tx.error || new Error("Chat history save was aborted."));
  });
}

export async function deleteConversation(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to delete chat history."));
    tx.onabort = () => reject(tx.error || new Error("Chat history delete was aborted."));
  });
}

export async function migrateSessionHistory() {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return;
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const messages = stored?.[SESSION_KEY];
  if (!Array.isArray(messages) || messages.length === 0) return;
  const existing = await listConversations();
  if (!existing.length) {
    const now = Date.now();
    await putConversation({
      id: crypto.randomUUID(),
      title: titleFromMessages(messages),
      createdAt: now,
      updatedAt: now,
      messages,
    });
  }
  await chrome.storage.session.remove(SESSION_KEY);
}
