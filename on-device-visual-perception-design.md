# On-device Visual Perception for a Privacy-Preserving Browser Agent

**Design Document**  
Smart India Hackathon — Client-side vision + privacy filter + server-side agent

---

## 1. Problem Restated

A browser extension watches the current tab, understands what’s on screen, and lets a server-side LLM agent act on it (click, type, navigate) **without ever sending raw sensitive data off the device**.

Everything that leaves the browser has already been through a redaction pass. The server never sees a real password, card number, face, or name unless we deliberately choose to let it — and by default it doesn’t.

Two things happen on the client before anything is transmitted:

1. **Sensitive regions** in the visible screen get masked (image-level).
2. **Sensitive text** in the DOM gets redacted (text-level).

The server runs an agent loop against a vision-language model. It sees redacted frames and redacted text, decides what to do, and calls tools that the extension executes.

---

## 2. Model Choices and What Each One Is For

| Model | Job | Where it runs |
|-------|-----|---------------|
| **xuanwulab/HaS_Image_0209_FP32** (YOLO11-seg, 21 privacy categories) | Pixel-level masks over faces, ID cards, screens, financial cards, biometrics in the captured frame | Client — ONNX Runtime Web + WebGPU |
| **openai/privacy-filter** (token classification) | Tags PII spans in page text: names, emails, phones, addresses, account numbers, secrets | Client — transformers.js + WebGPU |
| **deepseek-v4-flash-vision-exp** | The actual browser-use agent. Takes redacted screenshot + task text, decides the next action or tool call | Server |

None of the three do each other’s job:

- The YOLO model finds sensitive *pixels*, not buttons.
- The NER model finds sensitive *words*, not layout.
- The VLM does not see anything raw — it only sees what has already been through the first two.

We are **not** adding a fourth model for general UI element detection. The DOM accessibility tree already gives us element roles, labels, and coordinates for free on any page we have a content script in. Running a second vision model to rediscover what the DOM already tells us would waste latency budget for no accuracy gain.

---

## 3. Client Architecture

### 3.1 Extension Shape

Manifest V3. Three contexts:

- **Background service worker**  
  Owns the agent loop, holds the WebSocket/HTTP connection to the server, dispatches tool calls to the right tab, owns `chrome.debugger` attach/detach lifecycle.

- **Content script**  
  Injected per-tab. Walks the DOM, builds the accessibility summary, executes low-level actions (click, type, scroll) when the background script asks.

- **Side panel UI**  
  Shows the user what the agent is doing, the current task, and a live view of what got redacted (transparency matters for trust and for the demo).

### 3.2 Capturing the Screen

```js
chrome.tabs.captureVisibleTab(windowId, { format: "png" })
```

From the background service worker. **Visible viewport only** — not a stitched full-page shot. This keeps the frame size predictable and the HaS inference cost fixed per turn instead of scaling with page length.

### 3.3 Reading the Page: Two Ways, Picked Deliberately

We use both, split by role:

#### A. Content-script DOM walk (default path)

Fast, free, gives us the semantic accessibility tree: role, label, tag, bounding box, current value. Built the same way Chrome’s own accessible-name computation works:

- `aria-label`
- `placeholder`
- `title`
- `alt`
- associated `<label>`
- fallback text content

Every element that matters gets a stable `ref` id (`ref_1`, `ref_2`, …) stored in a `WeakMap` on `window`, reused across turns so the agent can refer to “the thing I saw two turns ago” without re-walking the whole tree.

Elements the DOM walk flags as sensitive by type (`type="password"`, `autocomplete="cc-number"`, `type="email"` with a filled value, etc.) get redacted **before** their label or value is ever serialized. This is the cheap, deterministic first line of defense and is what `get_page_state` and `read_element` are built on.

#### B. Chrome DevTools Protocol via `chrome.debugger`

This is what Anthropic’s own Claude-for-Chrome extension uses under the hood, and it’s the right call for anything the DOM walk can’t reach cleanly:

- Cross-origin iframes
- Shadow DOM
- Canvas-rendered UI
- When we want the browser’s own `Accessibility.getFullAXTree`

```json
// manifest.json (relevant parts)
{
  "permissions": ["debugger", "activeTab", "scripting", "storage", "sidePanel"],
  "host_permissions": ["<all_urls>"]
}
```

```js
// background.js
await chrome.debugger.attach({ tabId }, "1.3");
const { nodes } = await chrome.debugger.sendCommand(
  { tabId }, "Accessibility.getFullAXTree"
);
await chrome.debugger.detach({ tabId });
```

We **attach only for the duration of a single tool call** (get page state, or an input-simulation action) and detach immediately after. Chrome shows a “this extension is debugging this browser” banner while attached — that’s expected and we tell the user about it up front in the UI rather than trying to hide it. Attaching per-call instead of holding the debugger open for the whole session keeps the banner from sitting there permanently, which matters for the “resource utilization” and general trust story.

**Practically:**

- DOM walk is the **default** path for `get_page_state` (near-instant, covers the overwhelming majority of real pages).
- CDP is the path for `click` / `type` when we want dispatch-level input events instead of a synthetic DOM event a page’s JS might ignore, and for reading the accessibility tree of embedded frames the content script can’t touch due to cross-origin restrictions.

### 3.4 Local Inference Stack

- **ONNX Runtime Web**, `executionProviders: ["webgpu"]`, for HaS image segmentation.
- **transformers.js**,  
  `pipeline("token-classification", "openai/privacy-filter", { device: "webgpu", dtype: "q4" })`  
  for text NER. Same call shape as the reference demo, pointed at real page text.

Both models load once per session (lazily, on first use, with a loading indicator in the side panel) and stay warm in memory for the rest of the tab’s life.

### 3.5 HaS Export Pipeline

The published checkpoint is a `.pt` Ultralytics YOLO11-seg file, ~133 MB, FP32. Not browser-ready as-is.

Steps:

1. Check the `xuanwulab` org for an existing ONNX or quantized sibling repo before doing any of this by hand.
2. If none exists:
   ```python
   from ultralytics import YOLO
   model = YOLO("sensitive_seg_best.pt")
   model.export(format="onnx", opset=12, simplify=True, nms=True)
   ```
   NMS baked into the graph so we don’t reimplement it in JS.
3. Quantize. Start with **FP16** (`half=True` at export, or `onnxconverter-common.float16.convert_float_to_float16` as a post-step). Halves the size, near-zero accuracy cost.
4. INT8 static quantization is a stretch goal if FP16 still feels heavy. It needs a small calibration image set covering the 21 categories; instance segmentation tends to lose mask quality faster than classification under INT8, so we validate visually before committing.
5. Confirm the checkpoint’s actual backbone size. If we have time later, distill or fine-tune down to `yolo11n-seg` / `yolo11s-seg`. Not attempted in the first pass.

**Post-processing in JS**

Decode YOLO11-seg’s mask coefficients against the prototype mask output → threshold → resize each instance mask back to the original frame size → either black-box or gaussian-blur each masked region **before** the frame is allowed to leave the device.

### 3.6 Redaction, Concretely

Two redaction paths, feeding one rule: **nothing sensitive is serialized, ever**, in either the image or the text channel.

**Image path**  
Captured frame → HaS inference → per-instance masks → each mask region gets blacked out or blurred directly on the canvas → only the redacted canvas is ever turned into a blob and sent.

**Text path**  
Any text pulled by `get_page_state` or `read_element` first passes through the NER model. Detected spans get replaced with a placeholder token that still tells the agent what kind of thing was there without revealing the value:

```
[REDACTED:EMAIL]
[REDACTED:PASSWORD]
[REDACTED:CARD]
[REDACTED:NAME]
```

Structured DOM fields (password inputs, autocomplete-tagged fields) are redacted by type **before** they ever reach the NER model, since we already know they’re sensitive without needing a model to tell us.

### 3.7 The Tool Contract

This is the shared schema both client and server build against. Defining it once, up front, saves a lot of back-and-forth later.

```ts
type Tool =
  | { name: "get_page_state" }
  // → { url, title, elements: [{ ref, role, label, value? }] }

  | { name: "read_element"; selector_ref: string }
  // → { ref, role, label, value } (value redacted if sensitive)

  | { name: "click"; selector_ref: string }

  | { name: "type"; selector_ref: string; text: string }

  | { name: "scroll"; direction: "up" | "down"; amount_px: number }

  | { name: "navigate"; url: string }

  | { name: "screenshot" };
  // → redacted PNG of current viewport
```

Every tool result that could contain sensitive text goes through the text redaction pass before it’s serialized into the tool-result message sent back to the model.  
`screenshot` always returns an already-redacted frame — there is **no raw path** out of the client at all.

---

## 4. Server Architecture

The server is a thin agent loop, not a custom pipeline. It does normal tool-calling against **deepseek-v4-flash-vision-exp** (OpenAI-compatible Chat Completions or Anthropic-compatible `/messages` — DeepSeek supports both).

**Loop**

1. User gives a task in the side panel (“fill out this form”, “find the checkout button and click it”).
2. Server sends the task plus the current redacted screenshot to the model, with the tool schema above attached.
3. Model replies with either a final answer or a tool call.
4. Server relays the tool call to the extension’s background service worker over the open connection.
5. Extension executes it (DOM walk or CDP, depending on the tool), redacts anything sensitive in the result, sends the result back.
6. Server appends the tool result to the conversation and calls the model again.
7. Repeat until the model returns a final answer or a max-turn limit is hit.

DeepSeek’s vision input caps each image at 384 tokens, so we do **not** send a screenshot on every single turn. We only attach a fresh screenshot when the model actually asked for one via the `screenshot` tool or at loop start. This keeps token cost and latency down.

**Known gap**  
`deepseek-v4-flash-vision-exp` is cloud-hosted only right now (no open-weight release). The problem statement allows cloud-hosted models during the hackathon, so this is fine for the demo. If the evaluation specifically rewards fully offline-deployable server stacks, we document this as a tradeoff. A same-shaped fallback (self-hosted Qwen2-VL with tool calling) is a drop-in swap later because the tool contract does not change.

---

## 5. Data Flow, End to End

```
[tab]
  ├─ captureVisibleTab ──► [HaS + ONNX Runtime Web / WebGPU] ──► redacted PNG
  └─ content script DOM walk ──► [openai/privacy-filter NER] ──► redacted element list
                │
                ▼
      background service worker
                │
                ▼
      server agent loop (DeepSeek V4 Flash Vision)
                │
                ▼
           tool call decision
                │
                ▼
      background service worker dispatches
                │
      ┌─────────┴─────────┐
      │                   │
 content script        chrome.debugger
 (click / type /       (CDP-level input)
  scroll)                  │
      │                   │
      └─────────┬─────────┘
                │
         redact any resulting text
                │
                ▼
      tool result ──► back to server
```

---

## 6. Mapping to the Evaluation Metrics

| Metric | Weight | How we address it |
|--------|--------|-------------------|
| Accuracy of visual context from screen | 25% | Accessibility-tree-first approach for structure + HaS for privacy-relevant regions + capable VLM (DeepSeek V4 Flash Vision) for reasoning |
| Recall & precision for detection of sensitive / PII data | 20% | Layered detection: deterministic DOM-type rules first (free, perfect precision on structured fields) → NER model for unstructured text → HaS segmentation for visual PII |
| Precision of redaction | 20% | We redact **before** serialization. Structured fields never get put into a string in the first place. This makes precision close to deterministic for the largest category of leaks |
| Client-side resource utilization | 20% | WebGPU for both local models, FP16-quantized HaS, viewport-only capture, on-demand DOM state, per-call `chrome.debugger` attach/detach |
| Overall end-to-end latency of the provided task | 15% | DOM walk is near-free and is the default path; screenshots and CDP calls only happen when actually needed; tool calls only send a fresh image when the model asks for one |

---

## 7. Side Panel UI

Chrome has a dedicated `sidePanel` API. We use it instead of a popup because the panel stays open and persists across tab switches — critical for an agent that may run for many turns.

### Manifest

```json
{
  "manifest_version": 3,
  "name": "Privacy Agent",
  "version": "0.1.0",
  "permissions": [
    "sidePanel",
    "debugger",
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "Open Privacy Agent"
  }
}
```

Note: `action` has **no** `default_popup`. If you set a popup, clicking the toolbar icon opens the popup instead of the side panel.

### Open the panel on icon click

```js
// background.js
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
```

### Side panel HTML

```html
<!-- sidepanel/sidepanel.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="sidepanel.css" />
</head>
<body>
  <div id="app">
    <header>
      <h1>Agent</h1>
      <span id="status">idle</span>
    </header>

    <div id="task-input">
      <textarea id="task" placeholder="What should the agent do?"></textarea>
      <button id="run">Run</button>
    </div>

    <div id="log"></div>

    <div id="redaction-preview">
      <h2>Last redacted frame</h2>
      <img id="preview-img" alt="redacted screenshot preview" />
    </div>
  </div>
  <script type="module" src="sidepanel.js"></script>
</body>
</html>
```

### Side panel JS (messaging)

```js
// sidepanel/sidepanel.js
const runBtn = document.getElementById("run");
const taskInput = document.getElementById("task");
const log = document.getElementById("log");
const status = document.getElementById("status");
const previewImg = document.getElementById("preview-img");

runBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) return;
  status.textContent = "running";
  chrome.runtime.sendMessage({ type: "START_AGENT_TASK", task });
});

// background service worker pushes updates here as the loop runs
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AGENT_STEP") {
    appendLog(msg.text);
  }
  if (msg.type === "AGENT_FRAME") {
    previewImg.src = msg.dataUrl; // redacted frame, base64 PNG
  }
  if (msg.type === "AGENT_DONE") {
    status.textContent = "idle";
    appendLog("done: " + msg.result);
  }
});

function appendLog(text) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
```

The side panel and the background service worker talk over standard `chrome.runtime.sendMessage` / `onMessage`. The panel sends the task in; the background worker (which owns the agent loop, tab capture, and tool dispatch) pushes step-by-step updates and redacted frame previews back out.

**Notes**

- The side panel can only be opened from a user gesture the first time.
- It is a full page, not an iframe over the tab, so it has no direct DOM access to the page. All page interaction still goes through the content script or `chrome.debugger`.
- Reload the extension from `chrome://extensions` after adding `side_panel` to the manifest — Chrome will not hot-pick-up new manifest keys.

---

## 8. Build Order

1. **Extension skeleton**  
   Manifest V3, background service worker, `captureVisibleTab` wired up and confirmed working end-to-end into a canvas. Side panel declared and openable.

2. **Check for existing HaS ONNX**  
   Look in the `xuanwulab` Hugging Face org for an already-exported / quantized version before exporting by hand.

3. **Export HaS → ONNX**  
   opset 12, NMS baked in, `simplify=True`. Convert to FP16.

4. **Load HaS in-browser**  
   ONNX Runtime Web + WebGPU. Run on one captured frame, confirm masks decode and land in the right place. Wire simple black-box / blur redaction.

5. **Wire openai/privacy-filter**  
   transformers.js on real DOM text (reuse the reference demo’s NER call shape).

6. **Lock the tool schema**  
   Section 3.7 as a shared TypeScript / JSON Schema file both sides import, before either side goes further.

7. **Content-script DOM walker**  
   Build the accessibility summary, tag sensitive fields by type, implement `get_page_state` and `read_element`.

8. **chrome.debugger CDP path**  
   For `click` / `type`. Attach-per-call, detach immediately after.

9. **Server stub**  
   DeepSeek V4 Flash Vision, 2–3 tools wired (`get_page_state`, `click`, `type`). Prove one trivial task closes the loop end-to-end (e.g. “click the login button”).

10. **Remaining tools + harden redaction**  
    Add `scroll`, `navigate`, `screenshot`, `read_element`. Tighten redaction coverage across both channels. Add max-turn cap and timeout handling.

---

## 9. Open Items to Settle Before Demo Day

- **INT8 vs FP16 for HaS** — decide after seeing real latency numbers on target hardware, not in the abstract.
- Whether to distill down to a smaller YOLO11 backbone if the current checkpoint turns out heavier than expected.
- **Fallback VLM** (Qwen2-VL, self-hosted) in case DeepSeek’s experimental endpoint has uptime issues during the actual demo.
- Max-turn cap and timeout handling for the agent loop so a confused model doesn’t loop forever on stage.
- Confirm whether evaluation judges will accept a cloud-hosted VLM or whether a fully offline server is required.

---

*Document last updated: 31 Aug 2026*
