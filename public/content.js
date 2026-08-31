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

  function clean(value, limit = 160) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
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
    if (aria) return clean(aria);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(" ");
      if (label) return clean(label);
    }

    if (element.labels?.length) {
      const label = Array.from(element.labels)
        .map((item) => item.textContent)
        .join(" ");
      if (label) return clean(label);
    }

    return clean(
      element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        element.textContent,
    );
  }

  function roleFor(element) {
    if (element.getAttribute("role")) return element.getAttribute("role");
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") return "textbox";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "region";
  }

  function serializeElement(element) {
    const kind = sensitiveKind(element);
    const value = "value" in element ? String(element.value ?? "") : "";
    const rect = element.getBoundingClientRect();

    return {
      ref: getRef(element),
      role: roleFor(element),
      tag: element.tagName.toLowerCase(),
      label: getLabel(element) || "Unlabeled element",
      value: kind ? SENSITIVE_REDACTIONS[kind] : clean(value, 240),
      sensitive: Boolean(kind),
      sensitiveKind: kind || undefined,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function collectElements() {
    const selector = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "[role]",
      "[contenteditable='true']",
      "h1",
      "h2",
      "h3",
    ].join(",");

    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .slice(0, 80)
      .map(serializeElement);
  }

  function pageState() {
    const bodyText = clean(document.body?.innerText || "", 12000);
    return {
      url: location.href,
      title: document.title || "Untitled page",
      elements: collectElements(),
      textForLocalModel: bodyText,
      capturedAt: new Date().toISOString(),
    };
  }

  function resolve(ref) {
    const element = elementsByRef.get(ref);
    if (!element || !document.contains(element)) {
      throw new Error(`Element ${ref || "(missing ref)"} is no longer on the page.`);
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
    return {
      ...serializeElement(element),
      value: serializeElement(element).value,
    };
  }

  function clickElement(selectorRef) {
    const element = resolve(selectorRef);
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.click();
    return { action: "click", ref: selectorRef, label: getLabel(element) || "element" };
  }

  function typeElement(selectorRef, text) {
    const element = resolve(selectorRef);
    const kind = sensitiveKind(element);
    if (kind) {
      throw new Error("Typing into sensitive fields is blocked in the local test harness.");
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
      throw new Error("The selected element is not editable.");
    }

    if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      dispatchInput(element, text);
    }
    return { action: "type", ref: selectorRef, text, label: getLabel(element) || "element" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message.type) {
        case "PING":
          sendResponse({ ok: true });
          break;
        case "GET_PAGE_STATE":
          sendResponse({ ok: true, result: pageState() });
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
        case "SCROLL": {
          const amount = Math.max(80, Math.min(1200, Number(message.amountPx) || 320));
          window.scrollBy({ top: message.direction === "up" ? -amount : amount, behavior: "smooth" });
          sendResponse({ ok: true, result: { action: "scroll", direction: message.direction, amountPx: amount } });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown content action: ${message.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
})();
