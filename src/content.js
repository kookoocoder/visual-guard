const STABLE_REF_MAX = 2000;
const refMap = new WeakMap();
let refCounter = 0;

const SENSITIVE_TYPE = new Set([
  "password",
  "cc-name",
  "cc-number",
  "cc-exp",
  "cc-csc",
  "cc-type",
  "email",
]);

function getStableRef(el) {
  if (refMap.has(el)) return refMap.get(el);
  const ref = `ref_${++refCounter}`;
  refMap.set(el, ref);
  if (refMap.size > STABLE_REF_MAX) {
    const first = refMap.keys().next().value;
    refMap.delete(first);
  }
  return ref;
}

function isSensitiveField(el) {
  if (el.matches && el.matches("[type=password], input[autocomplete^=cc-], [autocomplete=cc-csc]")) {
    return true;
  }
  const auto = el.autocomplete;
  if (typeof auto === "string" && SENSITIVE_TYPE.has(auto)) return true;
  const type = el.type;
  if (type === "password") return true;
  if (type && SENSITIVE_TYPE.has(type.toLowerCase())) return true;
  return false;
}

function accessibleName(el) {
  const aria = el.getAttribute && el.getAttribute("aria-label");
  if (aria) return aria;
  if (el.placeholder) return el.placeholder;
  if (el.title) return el.title;
  if (el.alt) return el.alt;
  const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
  if (labelledBy && el.ownerDocument) {
    const holder = el.ownerDocument.getElementById(labelledBy);
    if (holder) return innerText(holder);
  }
  if (el.labels && el.labels.length > 0) {
    for (const l of el.labels) {
      const t = innerText(l);
      if (t) return t;
    }
  }
  return innerText(el);
}

function innerText(el) {
  return (el.innerText || el.textContent || "").trim().slice(0, 2000);
}

const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=combobox],[tabindex]:not([tabindex="-1"])';

function isVisible(el) {
  if (!el.offsetParent && el.tagName !== "BODY") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function walkTree(root) {
  const nodes = [];
  const all = root.querySelectorAll(INTERACTIVE);
  const collected = [];
  for (const el of all) {
    if (isVisible(el)) collected.push(el);
    if (collected.length >= 300) break;
  }
  for (const el of collected) {
    const sensitive = isSensitiveField(el);
    let value;
    if (sensitive) {
      value = "[REDACTED:FIELD]";
    } else if (typeof el.value === "string" && el.value) {
      value = el.value;
    }
    const text = sensitive ? "[REDACTED:FIELD]" : innerText(el);
    nodes.push({
      ref: getStableRef(el),
      role: el.getAttribute("role") || elementRole(el),
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute("aria-label") || text || "").slice(0, 300),
      value,
      rect: box(el),
    });
  }
  return nodes;
}

function elementRole(el) {
  const tag = el.tagName;
  if (tag === "A" || tag === "BUTTON") return "button";
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "password") return "textbox password";
    return "textbox";
  }
  if (tag === "SELECT") return "combobox";
  if (tag === "TEXTAREA") return "textbox";
  return "generic";
}

function box(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

function findElement(ref) {
  const all = document.querySelectorAll(INTERACTIVE);
  for (const el of all) {
    if (refMap.get(el) === ref) return el;
  }
  for (const el of all) {
    const id = el.getAttribute("ref");
    if (id === ref) return el;
  }
  return null;
}

function getPageState() {
  return {
    ok: true,
    url: location.href,
    title: document.title,
    elements: walkTree(document),
  };
}

function readElement(ref) {
  const el = findElement(ref);
  if (!el) return { ok: false, error: "element not found" };
  const sensitive = isSensitiveField(el);
  return {
    ok: true,
    ref,
    role: el.getAttribute("role") || elementRole(el),
    label: (el.getAttribute("aria-label") || innerText(el) || "").slice(0, 300),
    value: sensitive ? "[REDACTED:FIELD]" : el.value,
    sensitive,
  };
}

function clickRef(ref) {
  const el = findElement(ref);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true, ref, clicked: el.tagName };
}

function typeRef(ref, text) {
  const el = findElement(ref);
  if (!el) return { ok: false, error: "element not found" };
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, ref, len: text.length };
}

function scrollPage(direction, amountPx) {
  const amount = direction === "up" ? -Math.abs(amountPx) : Math.abs(amountPx);
  window.scrollBy({ top: amount, behavior: "instant" });
  return { ok: true, deltaY: amount };
}

function navigate(url) {
  location.href = url;
  return { ok: true, url };
}

function fullText() {
  return document.body ? document.body.innerText.slice(0, 50000) : "";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  let result;
  switch (msg.type) {
    case "GET_PAGE_STATE":
      result = getPageState();
      break;
    case "READ_ELEMENT":
      result = readElement(msg.ref);
      break;
    case "CLICK":
      result = clickRef(msg.ref);
      break;
    case "TYPE":
      result = typeRef(msg.ref, msg.text || "");
      break;
    case "SCROLL":
      result = scrollPage(msg.direction, msg.amountPx || 600);
      break;
    case "NAVIGATE":
      result = navigate(msg.url || "");
      break;
    case "FULL_TEXT":
      result = { text: fullText() };
      break;
  }
  if (result !== undefined) sendResponse(result);
});
