(() => {
  if (window.__visualGuardContentScript) return;
  window.__visualGuardContentScript = true;

  const refs = new WeakMap();
  const elementsByRef = new Map();
  let nextRef = 1;

  const SENSITIVE_REDACTIONS = {
    password: "[REDACTED:PASSWORD]",
    card: "[REDACTED:CARD]",
    email: "[REDACTED:EMAIL]",
    secret: "[REDACTED:SECRET]",
  };

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "label",
    "summary",
    "option",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='option']",
    "[role='switch']",
    "[role='textbox']",
    "[role='combobox']",
    "[role='listitem']",
    "[role='treeitem']",
    "[role='heading']",
    "h1",
    "h2",
    "h3",
    "h4",
  ].join(",");

  function clean(value, limit = 160) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element) || window.getComputedStyle(element);
    return (
      rect.width > 1 &&
      rect.height > 1 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0
    );
  }

  function sensitiveKind(element) {
    const type = (element.getAttribute("type") || "").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    const hint = `${type} ${autocomplete} ${element.getAttribute("name") || ""}`.toLowerCase();

    if (type === "password" || /password|passcode|pin/.test(hint)) return "password";
    if (/cc-|card|credit/.test(hint)) return "card";
    if (type === "email" || /email/.test(hint)) return "email";
    if (/token|secret|api[-_ ]?key/.test(hint)) return "secret";
    return "";
  }

  function getRef(element) {
    let ref = refs.get(element);
    if (!ref) {
      ref = `ref_${nextRef++}`;
      refs.set(element, ref);
      elementsByRef.set(ref, element);
    }
    return ref;
  }

  function getLabel(element) {
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria, 240);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const doc = element.ownerDocument || document;
      const label = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(" ");
      if (label) return clean(label, 240);
    }

    if (element.labels?.length) {
      const label = Array.from(element.labels)
        .map((item) => item.textContent)
        .join(" ");
      if (label) return clean(label, 240);
    }

    if (element.tagName === "INPUT" && (element.type === "radio" || element.type === "checkbox")) {
      const parentLabel = element.closest("label");
      if (parentLabel) return clean(parentLabel.textContent, 240);
      const next = element.nextElementSibling;
      if (next) return clean(next.textContent, 240);
    }

    return clean(
      element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        element.textContent,
      240,
    );
  }

  function roleFor(element) {
    if (element.getAttribute("role")) return element.getAttribute("role");
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "label") return "label";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "region";
  }

  function absoluteBounds(element) {
    const rect = element.getBoundingClientRect();
    let x = rect.x;
    let y = rect.y;
    let view = element.ownerDocument?.defaultView;
    while (view && view !== window.top && view.frameElement) {
      const frameRect = view.frameElement.getBoundingClientRect();
      x += frameRect.x;
      y += frameRect.y;
      view = view.parent;
    }
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function serializeElement(element) {
    const kind = sensitiveKind(element);
    const value =
      "value" in element
        ? String(element.value ?? "")
        : element.isContentEditable || element.getAttribute("role") === "textbox"
          ? String(element.innerText || element.textContent || "")
          : "";
    const bounds = absoluteBounds(element);
    const checked =
      element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")
        ? Boolean(element.checked)
        : element.getAttribute("aria-checked") === "true"
          ? true
          : element.getAttribute("aria-checked") === "false"
            ? false
            : undefined;

    return {
      ref: getRef(element),
      role: roleFor(element),
      tag: element.tagName.toLowerCase(),
      label: getLabel(element) || "Unlabeled element",
      value: kind ? SENSITIVE_REDACTIONS[kind] : clean(value, 240),
      checked,
      sensitive: Boolean(kind),
      sensitiveKind: kind || undefined,
      bounds,
    };
  }

  function collectDocuments() {
    // One document per content-script world. Cross-frame coverage comes from
    // manifest all_frames + background gatherPageState.
    return document.body ? [document] : [];
  }

  function mainRoot(doc = document) {
    return (
      doc.querySelector("main, [role='main'], #content, #main, .main-content, .course-content, .assessment, .quiz") ||
      doc.body
    );
  }

  function inNavChrome(element) {
    return Boolean(
      element.closest(
        "nav, header, footer, aside, [role='navigation'], [role='banner'], [role='complementary'], .sidebar, .side-nav, .course-nav, #course-nav",
      ),
    );
  }

  function viewportScore(bounds) {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
    if (!inView) return -Math.abs(cy - vh / 2) / vh;
    const centerDist = Math.hypot(cx - vw * 0.55, cy - vh * 0.45) / Math.hypot(vw, vh);
    return 1.5 - centerDist;
  }

  function elementPriority(serialized, element) {
    const role = serialized.role;
    let score = viewportScore(serialized.bounds);
    if (["radio", "checkbox", "textbox", "combobox", "option", "heading", "button", "label"].includes(role)) {
      score += 3;
    }
    if (["link", "tab", "menuitem", "treeitem"].includes(role)) score += 0.5;
    if (element.type === "radio" || element.type === "checkbox") score += 4;
    if (!inNavChrome(element)) score += 4;
    else score -= 3;
    if (mainRoot(element.ownerDocument || document).contains(element)) score += 2;
    const label = serialized.label.toLowerCase();
    if (/question|option|answer|submit|next|previous|choice|mcq|assessment/i.test(label)) score += 3;
    if (/jump to|skip to|donate|log in|sign in|cookie/i.test(label)) score -= 2;
    return score;
  }

  function collectElements(limit = 120) {
    const collected = [];
    const seen = new Set();

    for (const doc of collectDocuments()) {
      for (const element of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        const serialized = serializeElement(element);
        if (!serialized.label || serialized.label === "Unlabeled element") continue;
        collected.push({ element, serialized, score: elementPriority(serialized, element) });
      }
    }

    collected.sort((a, b) => b.score - a.score);
    return collected.slice(0, limit).map((item) => item.serialized);
  }

  function collectReadableText(maxChars = 8000) {
    const chunks = [];
    for (const doc of collectDocuments()) {
      const root = mainRoot(doc);
      const text = clean(root?.innerText || doc.body?.innerText || "", maxChars);
      if (text) chunks.push(text);
    }
    const joined = chunks.join("\n\n").slice(0, maxChars);
    if (joined.length >= 200) return joined;
    return clean(document.body?.innerText || "", maxChars);
  }

  const REAL_REDACTION_KEYS = new Set([
    "NAME",
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "DATE",
    "URL",
    "CARD",
    "PASSWORD",
    "SECRET",
    "ID",
  ]);

  let activeTextRedactions = [];
  let textRedactionObserver = null;
  let textRedactionScheduled = false;

  function normalizeTextRedactions(redacted) {
    if (!Array.isArray(redacted)) return [];

    const entries = [];
    const seen = new Set();
    for (const item of redacted) {
      const kind = String(item?.kind ?? "").trim().toUpperCase();
      if (!REAL_REDACTION_KEYS.has(kind)) continue;

      const placeholder = `[${kind}]`;
      if (item.placeholder != null && item.placeholder !== placeholder) continue;

      const value = String(item?.value ?? "").trim();
      if (!value || value === placeholder) continue;

      const key = `${kind}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ value, placeholder });
    }

    return entries.sort((a, b) => b.value.length - a.value.length);
  }

  function isWordCharacter(value) {
    return Boolean(value) && /[\p{L}\p{N}_]/u.test(value);
  }

  function hasSafeBoundaries(text, start, value) {
    if (!isWordCharacter(value[0]) || !isWordCharacter(value[value.length - 1])) return true;
    return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[start + value.length]);
  }

  function replaceEntry(text, entry) {
    let cursor = 0;
    let replaced = 0;
    let output = "";

    while (cursor < text.length) {
      const start = text.indexOf(entry.value, cursor);
      if (start < 0) break;

      if (!hasSafeBoundaries(text, start, entry.value)) {
        output += text.slice(cursor, start + entry.value.length);
        cursor = start + entry.value.length;
        continue;
      }

      output += text.slice(cursor, start) + entry.placeholder;
      cursor = start + entry.value.length;
      replaced += 1;
    }

    if (!replaced) return { text, count: 0 };
    return { text: output + text.slice(cursor), count: replaced };
  }

  function replaceTextNodeValues(entries) {
    if (!document.body) return 0;

    let replaced = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, noscript, template")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      let value = node.nodeValue;
      for (const entry of entries) {
        const result = replaceEntry(value, entry);
        value = result.text;
        replaced += result.count;
      }
      if (value !== node.nodeValue) node.nodeValue = value;
    }
    return replaced;
  }

  function queueActiveTextRedaction() {
    if (textRedactionScheduled || !activeTextRedactions.length) return;
    textRedactionScheduled = true;
    setTimeout(() => {
      textRedactionScheduled = false;
      replaceTextNodeValues(activeTextRedactions);
    }, 0);
  }

  function observeTextRedactions() {
    if (textRedactionObserver || !document.body) return;
    textRedactionObserver = new MutationObserver(queueActiveTextRedaction);
    textRedactionObserver.observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  function applyTextRedactions(redacted) {
    const entries = normalizeTextRedactions(redacted);
    if (!entries.length) {
      return { ok: true, replaced: 0, keys: [] };
    }

    const existing = new Map(activeTextRedactions.map((entry) => [entry.placeholder + entry.value, entry]));
    for (const entry of entries) existing.set(entry.placeholder + entry.value, entry);
    activeTextRedactions = [...existing.values()].sort((a, b) => b.value.length - a.value.length);

    const replaced = replaceTextNodeValues(activeTextRedactions);
    observeTextRedactions();
    return {
      ok: true,
      replaced,
      keys: entries.map((entry) => entry.placeholder).filter((key, index, all) => all.indexOf(key) === index),
    };
  }

  function pageState() {
    // Drop stale refs that were removed from the DOM so click/type stay reliable.
    for (const [ref, element] of [...elementsByRef.entries()]) {
      if (!element?.isConnected) elementsByRef.delete(ref);
    }

    return {
      url: location.href,
      title: document.title || "Untitled page",
      elements: collectElements(120),
      textForLocalModel: collectReadableText(8000),
      frame: window === window.top ? "top" : "iframe",
      capturedAt: new Date().toISOString(),
    };
  }

  function resolve(ref) {
    const element = elementsByRef.get(ref);
    if (!element || !element.isConnected) {
      throw new Error(`Element ${ref || "(missing ref)"} is no longer on the page. Call get_page_state again.`);
    }
    return element;
  }

  function dispatchInput(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function readElement(selectorRef) {
    const element = resolve(selectorRef);
    return serializeElement(element);
  }

  function firePointer(element, type) {
    const view = element.ownerDocument?.defaultView || window;
    const rect = element.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      button: 0,
      buttons: type === "mouseup" || type === "click" ? 0 : 1,
    };
    if (type !== "click") {
      try {
        if (typeof PointerEvent === "function") {
          element.dispatchEvent(
            new PointerEvent(type.replace("mouse", "pointer"), {
              ...opts,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            }),
          );
        }
      } catch {
        // Older pages / restricted nodes may reject PointerEvent.
      }
    }
    element.dispatchEvent(new MouseEvent(type, opts));
  }

  function isSendControl(element) {
    const hint = [
      getLabel(element),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("data-testid"),
      element.getAttribute?.("data-icon"),
      element.getAttribute?.("type"),
    ]
      .filter(Boolean)
      .join(" ");
    return /send|submit/i.test(hint);
  }

  function activateOnce(element) {
    element.click?.();
  }

  function clickElement(selectorRef) {
    const element = resolve(selectorRef);
    element.scrollIntoView({ block: "center", inline: "nearest" });

    const target =
      element.tagName === "LABEL" && element.control
        ? element.control
        : element;

    try {
      target.focus?.({ preventScroll: true });
    } catch {
      target.focus?.();
    }

    if (isSendControl(target)) {
      activateOnce(target);
    } else {
      firePointer(target, "mouseover");
      firePointer(target, "mousedown");
      firePointer(target, "mouseup");
      activateOnce(target);
    }

    if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio") && !target.checked) {
      target.checked = true;
      target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    return { action: "click", ref: selectorRef, label: getLabel(element) || "element", role: roleFor(element) };
  }

  function typeElement(selectorRef, text) {
    const element = resolve(selectorRef);
    const target = editableTarget(element);
    if (!isEditable(target)) {
      throw new Error("The selected element is not editable.");
    }
    const blocked = sensitiveKind(target);
    if (blocked === "password" || blocked === "card" || blocked === "secret") {
      throw new Error("Typing into sensitive fields is blocked.");
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    writeText(target, text);
    return { action: "type", ref: selectorRef, text, label: getLabel(target) || "element" };
  }

  function isEditable(element) {
    if (!element) return false;
    if (element instanceof HTMLInputElement) {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image"].includes(type);
    }
    return (
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable ||
      element.getAttribute("contenteditable") === "true" ||
      element.getAttribute("role") === "textbox"
    );
  }

  function editableTarget(element) {
    if (isEditable(element)) return element;
    const nested = element.querySelector?.(
      "textarea, [contenteditable='true'], [role='textbox'], input:not([type='hidden']):not([type='radio']):not([type='checkbox']):not([type='submit']):not([type='button']):not([type='file'])",
    );
    if (isEditable(nested)) return nested;
    if (element instanceof HTMLLabelElement && isEditable(element.control)) return element.control;
    return element;
  }

  function writeText(element, text) {
    const doc = element.ownerDocument || document;
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }

    const wanted = String(text ?? "");
    const current = fieldText(element);
    if (current === wanted || isExactRepeat(current, wanted)) {
      if (current !== wanted) replaceField(element, wanted);
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      dispatchInput(element, wanted);
      return;
    }

    const selection = (doc.defaultView || window).getSelection?.();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    doc.execCommand?.("delete", false, null);
    if (!doc.execCommand?.("insertText", false, wanted)) {
      replaceField(element, wanted);
      return;
    }
    if (isExactRepeat(fieldText(element), wanted)) replaceField(element, wanted);
  }

  function fieldText(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return String(element.value ?? "");
    }
    return String(element.innerText || element.textContent || "");
  }

  function isExactRepeat(current, text) {
    const piece = String(text ?? "").replace(/\s+/g, "");
    const value = String(current ?? "").replace(/\s+/g, "");
    if (!piece || value.length < piece.length * 2 || value.length % piece.length !== 0) return false;
    return value === piece.repeat(value.length / piece.length);
  }

  function replaceField(element, text) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      dispatchInput(element, text);
      return;
    }
    element.textContent = text;
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }),
    );
  }

  function pressKey(selectorRef, key) {
    const element = editableTarget(resolve(selectorRef));
    const allowed = new Set(["Enter", "Escape", "Tab"]);
    if (!allowed.has(key)) throw new Error(`Unsupported key: ${key}`);

    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus?.();
    }

    const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : 9;
    const options = {
      key,
      code: key === "Enter" ? "Enter" : key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const accepted = element.dispatchEvent(new KeyboardEvent("keydown", options));
    element.dispatchEvent(new KeyboardEvent("keypress", options));
    element.dispatchEvent(new KeyboardEvent("keyup", options));

    return {
      action: "press_key",
      ref: selectorRef,
      key,
      handledByPage: !accepted,
      label: getLabel(element) || "element",
    };
  }

  function submitElement(selectorRef) {
    const composer = resolve(selectorRef);
    const form = composer.closest("form");
    const icon = document.querySelector('span[data-icon="send"], [data-testid="send"]');
    const target =
      form?.querySelector('button[type="submit"], input[type="submit"]') ||
      document.querySelector(
        'button[aria-label="Send"], [role="button"][aria-label="Send"], button[data-testid="send"]',
      ) ||
      icon?.closest('button, [role="button"]');

    if (!target || !isVisible(target)) {
      throw new Error("No visible Send/Submit control is available for this composer.");
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus?.();
    }
    activateOnce(target);

    return {
      action: "submit",
      ref: selectorRef,
      method: "send_control",
      controlLabel: getLabel(target) || target.getAttribute("data-testid") || "Send",
    };
  }

  function focusElement(selectorRef) {
    const element = resolve(selectorRef);
    element.scrollIntoView({ block: "center", inline: "nearest" });
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus?.();
    }
    const serialized = serializeElement(element);
    const fullValue =
      "value" in element
        ? String(element.value ?? "")
        : element.isContentEditable || element.getAttribute("role") === "textbox"
          ? String(element.innerText || element.textContent || "")
          : "";
    return {
      action: "focus",
      ref: selectorRef,
      label: serialized.label,
      value: serialized.sensitive ? "" : fullValue.slice(0, 12_000),
    };
  }

  function findScrollable(from = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)) {
    let node = from;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && node.scrollHeight > node.clientHeight + 20) {
        return node;
      }
      node = node.parentElement;
    }

    const main = mainRoot();
    if (main && main.scrollHeight > main.clientHeight + 20) return main;

    for (const candidate of document.querySelectorAll("main, [role='main'], .course-content, .assessment, .quiz, #content")) {
      if (candidate.scrollHeight > candidate.clientHeight + 20) return candidate;
    }

    return document.scrollingElement || document.documentElement;
  }

  function scrollPage(direction, amountPx) {
    const amount = Math.max(80, Math.min(1600, Number(amountPx) || 320));
    const delta = direction === "up" ? -amount : amount;
    const target = findScrollable();
    const before = target.scrollTop;
    target.scrollBy({ top: delta, behavior: "auto" });
    if (Math.abs(target.scrollTop - before) < 2) {
      window.scrollBy({ top: delta, left: 0, behavior: "auto" });
    }
    return {
      action: "scroll",
      direction,
      amountPx: amount,
      scrolledTop: Math.round(target.scrollTop || window.scrollY || 0),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message.type) {
        case "PING":
          sendResponse({ ok: true, frame: window === window.top ? "top" : "iframe" });
          break;
        case "GET_PAGE_STATE":
          sendResponse({ ok: true, result: pageState() });
          break;
        case "APPLY_TEXT_REDACTION":
          sendResponse(applyTextRedactions(message.redacted));
          break;
        case "READ_ELEMENT":
          sendResponse({ ok: true, result: readElement(message.selectorRef) });
          break;
        case "CLICK":
          sendResponse({ ok: true, result: clickElement(message.selectorRef) });
          break;
        case "TYPE":
          sendResponse({ ok: true, result: typeElement(message.selectorRef, message.text || "Local test") });
          break;
        case "PRESS_KEY":
          sendResponse({ ok: true, result: pressKey(message.selectorRef, message.key) });
          break;
        case "SUBMIT":
          sendResponse({ ok: true, result: submitElement(message.selectorRef) });
          break;
        case "FOCUS":
          sendResponse({ ok: true, result: focusElement(message.selectorRef) });
          break;
        case "SCROLL":
          sendResponse({
            ok: true,
            result: scrollPage(message.direction === "up" ? "up" : "down", message.amountPx),
          });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown content action: ${message.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
})();
