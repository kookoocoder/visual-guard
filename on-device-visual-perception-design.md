# On-device visual perception for a privacy-preserving browser agent

Design doc. Covers what we're building, why each piece is shaped the way it is, and how the client, models, and server talk to each other.

## 1. Problem restated

A browser extension watches the current tab, understands what's on screen, and lets a server-side LLM agent act on it (click, type, navigate) without ever sending raw sensitive data off the device. Everything that leaves the browser has already been through a redaction pass. The server never sees a real password, card number, face, or name unless we choose to let it, and by default it doesn't.

Two things happen on the client before anything is transmitted:

1. Sensitive regions in the visible screen get masked (image-level).
2. Sensitive text in the DOM gets redacted (text-level).

The server runs an agent loop against a vision-language model. It sees redacted frames and redacted text, decides what to do, and calls tools that the extension executes.

## 2. Model choices and what each one is for

| Model | Job | Where it runs |
|---|---|---|
| `xuanwulab/HaS_Image_0209_FP32` (YOLO11-seg, 21 privacy categories) | Pixel-level masks over faces, ID cards, screens, financial cards, biometrics in the captured frame | Client, ONNX Runtime Web, WebGPU |
| `openai/privacy-filter` (token classification) | Tags PII spans in page text: names, emails, phones, addresses, account numbers, secrets | Client, transformers.js, WebGPU |
| `deepseek-v4-flash-vision-exp` | The actual browser-use agent. Takes redacted screenshot + task text, decides the next action or tool call | Server |

None of the three do each other's job. The YOLO model finds sensitive pixels, not buttons. The NER model finds sensitive words, not layout. The VLM does not see anything raw, it only sees what's already been through the first two.

We are not adding a fourth model for general UI element detection. The DOM accessibility tree already gives us element roles, labels, and coordinates for free on any page we have a content script in. Running a second vision model to rediscover what the DOM already tells us would waste latency budget for no accuracy gain.

## 3. Client architecture

### 3.1 Extension shape

Manifest V3. Three contexts:

- **Background service worker.** Owns the agent loop, holds the WebSocket/HTTP connection to the server, dispatches tool calls to the right tab, owns `chrome.debugger` attach/detach lifecycle.
- **Content script.** Injected per-tab. Walks the DOM, builds the accessibility summary, executes low-level actions (click, type, scroll) when the background script asks.
- **Side panel or popup UI.** Shows the user what the agent is doing, the current task, a live view of what got redacted (transparency matters for trust and probably for the demo).

### 3.2 Capturing the screen

`chrome.tabs.captureVisibleTab(windowId, { format: "png" })` from the background service worker. Visible viewport only, not a stitched full-page shot, per the earlier decision. This keeps the frame size predictable and the HaS inference cost fixed per turn instead of scaling with page length.

### 3.3 Reading the page: two ways, picked deliberately

We looked at the two standard ways an extension can see structure, and we're using both, split by role:

**A. Content-script DOM walk.** Fast, free, gives us the semantic accessibility tree: role, label, tag, bounding box, current value. Built the same way Chrome's own accessible-name computation works: pull from `aria-label`, `placeholder`, `title`, `alt`, associated `<label>`, and fallback text content. Every element that matters gets a stable ref id (`ref_1`, `ref_2`, ...) stored in a `WeakMap` on `window`, reused across turns so the agent can refer to "the thing I saw two turns ago" without re-walking the whole tree. Elements the DOM walk flags as sensitive by type (`type="password"`, `autocomplete="cc-number"`, `type="email"` with a filled value, etc.) get redacted before their label or value is ever serialized. This is the cheap, deterministic first line of defense and it's what `get_page_state` and `read_element` are built on.

**B. Chrome DevTools Protocol via `chrome.debugger`.** This is what Anthropic's own Claude-for-Chrome extension uses under the hood, and it's the right call for us too for anything the DOM walk can't reach cleanly: cross-origin iframes, shadow DOM, canvas-rendered UI, or when we want the browser's own `Accessibility.getFullAXTree` instead of hand-rolling one.

```json
// manifest.json
{
  "permissions": ["debugger", "activeTab", "scripting", "storage"],
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

We attach only for the duration of a single tool call (get page state, or an input-simulation action) and detach immediately after. Chrome shows a "this extension is debugging this browser" banner while attached; that's expected and we tell the user about it up front in the UI rather than trying to hide it. Attaching per-call instead of holding the debugger open for the whole session keeps the banner from sitting there permanently, which matters for the "resource utilization" and general trust story.

Practically: DOM walk is the default path for `get_page_state`, since it's near-instant and covers the overwhelming majority of real pages. CDP is the path for `click`/`type` when we want dispatch-level input events instead of a synthetic DOM event a page's JS might ignore, and for reading the accessibility tree of embedded frames the content script can't touch due to cross-origin restrictions.

### 3.4 Local inference stack

- **ONNX Runtime Web**, `executionProviders: ["webgpu"]`, for HaS image segmentation.
- **transformers.js**, `pipeline("token-classification", "openai/privacy-filter", { device: "webgpu", dtype: "q4" })`, for text NER. Same call shape as the reference demo you found, just pointed at real page text instead of a hardcoded document.
- Both models load once per session (lazily, on first use, with a loading indicator in the side panel) and stay warm in memory for the rest of the tab's life.

### 3.5 HaS export pipeline (today's main task)

The published checkpoint is a `.pt` Ultralytics YOLO11-seg file, 133MB, FP32. Not browser-ready as-is. Steps:

1. Check the xuanwulab org for an existing ONNX or quantized sibling repo before doing any of this by hand.
2. If none exists: `from ultralytics import YOLO; model = YOLO("sensitive_seg_best.pt"); model.export(format="onnx", opset=12, simplify=True, nms=True)`. NMS baked into the graph so we don't reimplement it in JS.
3. Quantize. Start with FP16 (`half=True` at export, or `onnxconverter-common.float16.convert_float_to_float16` as a post-step) — halves the size, near-zero accuracy cost, fast to do today. INT8 static quantization is a stretch goal if FP16 still feels heavy in-browser; it needs a small calibration image set covering the 21 categories and instance segmentation tends to lose mask quality faster than classification under INT8, so we validate visually before committing to it.
4. Confirm the checkpoint's actual backbone size (133MB suggests it may not already be nano/small). If we have time later in the week, distill or fine-tune down to yolo11n-seg or yolo11s-seg for a lighter client footprint. Not attempted today; today is export + quantize + get it running.
5. Postprocessing in JS: decode YOLO11-seg's mask coefficients against the prototype mask output, threshold, resize each instance mask back to the original frame size, then either black-box or gaussian-blur each masked region before the frame is allowed to leave the device.

### 3.6 Redaction, concretely

Two redaction paths, feeding one rule: **nothing sensitive is serialized, ever, in either the image or the text channel.**

- **Image path.** Captured frame → HaS inference → per-instance masks → each mask region gets blacked out or blurred directly on the canvas → only the redacted canvas is ever turned into a blob and sent.
- **Text path.** Any text pulled by `get_page_state` or `read_element` first passes through the NER model. Detected spans get replaced with a placeholder token that still tells the agent what kind of thing was there without revealing the value, e.g. `[REDACTED:EMAIL]`, `[REDACTED:PASSWORD]`. Structured DOM fields (password inputs, autocomplete-tagged fields) are redacted by type before they ever reach the NER model, since we already know they're sensitive without needing a model to tell us.

### 3.7 The tool contract

This is the shared schema both client and server build against. Defining it once, up front, saves a lot of back-and-forth later.

```ts
type Tool =
  | { name: "get_page_state" }                         // → { url, title, elements: [{ ref, role, label, value? }] }
  | { name: "read_element"; selector_ref: string }      // → { ref, role, label, value }  (value redacted if sensitive)
  | { name: "click"; selector_ref: string }
  | { name: "type"; selector_ref: string; text: string }
  | { name: "scroll"; direction: "up" | "down"; amount_px: number }
  | { name: "navigate"; url: string }
  | { name: "screenshot" };                             // → redacted PNG of current viewport
```

Every tool result that could contain sensitive text goes through the text redaction pass before it's serialized into the tool-result message sent back to the model. `screenshot` always returns an already-redacted frame, never a raw one, there is no raw path out of the client at all.

## 3.8 Side panel UI

We use `chrome.sidePanel`, not a popup. A popup closes the moment focus leaves it, an agent that's mid-task needs to stay visible while the user looks at other tabs.

**Manifest additions:**

```json
{
  "permissions": ["sidePanel", "debugger", "activeTab", "scripting", "storage"],
  "side_panel": { "default_path": "sidepanel/sidepanel.html" },
  "action": { "default_title": "Open Privacy Agent" }
}
```

No `default_popup` on `action`. If one is set, the icon opens the popup instead of the panel.

```js
// background.js
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
```

**Design direction: native, not branded.** The panel should look like it belongs in Chrome's own UI, not like a third-party widget sitting next to it. That means:

- System font stack (`-apple-system, "Segoe UI", Roboto, sans-serif`), no custom webfont load.
- Chrome's own light/dark values: background `#fff` / `#202124` in dark mode, text `#202124` / `#e8eaed`, borders `#dadce0` / `#3c4043`. Match `prefers-color-scheme` rather than shipping one fixed theme.
- One accent color used sparingly (status dots, the active tool highlight), everything else neutral grey/white. No gradients, no drop shadows beyond a 1px border.
- Density over decoration: compact list rows, 13-14px body text, no illustration or empty-state art. This is a tool panel, not a marketing surface.
- Layout: header (extension name + connection/status dot) → task input (single-line-growing textarea + Run button) → collapsible sections below it: **Local models**, **Tools**, **Agent log**. Collapsed by default except the log, since the log is what you actually watch while a task runs.

```html
<!-- sidepanel/sidepanel.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="sidepanel.css" />
</head>
<body>
  <header>
    <span class="dot" id="status-dot"></span>
    <h1>Privacy Agent</h1>
  </header>

  <section id="task-box">
    <textarea id="task" placeholder="Describe the task"></textarea>
    <button id="run">Run</button>
  </section>

  <details id="models-panel" open>
    <summary>Local models</summary>
    <div class="model-row">
      <span class="dot" id="has-dot"></span>
      <span>HaS image segmentation</span>
      <button id="test-has">Test</button>
    </div>
    <div class="model-row">
      <span class="dot" id="ner-dot"></span>
      <span>PII text filter</span>
      <button id="test-ner">Test</button>
    </div>
  </details>

  <details id="tools-panel">
    <summary>Tools</summary>
    <div class="tool-row"><span>get_page_state</span><button data-tool="get_page_state">Test</button></div>
    <div class="tool-row"><span>read_element</span><button data-tool="read_element">Test</button></div>
    <div class="tool-row"><span>click</span><button data-tool="click">Test</button></div>
    <div class="tool-row"><span>type</span><button data-tool="type">Test</button></div>
    <div class="tool-row"><span>scroll</span><button data-tool="scroll">Test</button></div>
    <div class="tool-row"><span>screenshot</span><button data-tool="screenshot">Test</button></div>
  </details>

  <details id="log-panel" open>
    <summary>Agent log</summary>
    <div id="log"></div>
  </details>

  <div id="preview">
    <img id="preview-img" alt="" />
  </div>

  <script type="module" src="sidepanel.js"></script>
</body>
</html>
```

```css
/* sidepanel.css — kept deliberately plain */
:root {
  --bg: #fff; --fg: #202124; --border: #dadce0; --muted: #5f6368; --accent: #1a73e8;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #202124; --fg: #e8eaed; --border: #3c4043; --muted: #9aa0a6; --accent: #8ab4f8; }
}
body {
  margin: 0; font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--fg);
}
header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
}
header h1 { font-size: 13px; font-weight: 600; margin: 0; }
.dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0;
}
.dot.ready { background: #1e8e3e; }
.dot.busy { background: #f9ab00; }
.dot.error { background: #d93025; }
#task-box { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
#task { flex: 1; resize: none; height: 32px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; background: transparent; color: var(--fg); font: inherit; }
button {
  border: 1px solid var(--border); background: transparent; color: var(--fg);
  border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer;
}
button:hover { background: rgba(128,128,128,0.1); }
details { border-bottom: 1px solid var(--border); padding: 6px 12px; }
summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
.model-row, .tool-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 0; color: var(--muted);
}
.model-row span:nth-child(2), .tool-row span { flex: 1; color: var(--fg); font-family: ui-monospace, monospace; font-size: 12px; }
#log { max-height: 240px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px; }
.log-line { padding: 2px 0; border-bottom: 1px dashed var(--border); }
#preview img { width: 100%; border-top: 1px solid var(--border); display: block; }
```

That's the whole visual language: system font, two neutral surface colors that flip with dark mode, one accent, status conveyed with small colored dots instead of banners or badges. Nothing here needs a design pass beyond this, the goal is that it disappears into the browser chrome.

## 3.9 Setting up each on-device model for WebGPU

### HaS image segmentation (ONNX Runtime Web)

Install:

```bash
npm install onnxruntime-web
```

WebGPU is a separate build target from the default WASM one, import from the `/webgpu` entry point or the execution provider silently falls back to CPU:

```js
// models/has.js
import * as ort from "onnxruntime-web/webgpu";

let session = null;

export async function loadHaS() {
  if (session) return session;
  session = await ort.InferenceSession.create(
    "/models/has_seg_fp16.onnx",
    {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    }
  );
  return session;
}

export async function runHaS(imageTensor) {
  const s = await loadHaS();
  const feeds = { images: imageTensor }; // name must match the model's actual input name, check with Netron
  const results = await s.run(feeds);
  return results; // boxes, scores, classes, mask coefficients + prototypes for YOLO11-seg
}
```

Preprocessing a captured frame into the tensor the model expects:

```js
export function frameToTensor(imageBitmap, size = 640) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageBitmap, 0, 0, size, size); // letterbox properly in the real version
  const { data } = ctx.getImageData(0, 0, size, size);
  const float32 = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    float32[i] = data[i * 4] / 255;                     // R plane
    float32[size * size + i] = data[i * 4 + 1] / 255;    // G plane
    float32[2 * size * size + i] = data[i * 4 + 2] / 255;// B plane
  }
  return new ort.Tensor("float32", float32, [1, 3, size, size]);
}
```

Verify the model actually landed on WebGPU rather than falling back silently:

```js
console.log(session.handler.provider); // should read "webgpu", not "wasm" or "cpu"
```

If it falls back, the usual causes are: browser without WebGPU enabled (needs Chrome 113+, no flag required on current stable), an op in the graph the WebGPU EP doesn't support yet (check the console warning, it names the op), or importing the default `onnxruntime-web` entry instead of the `/webgpu` one.

### PII text filter (transformers.js)

```bash
npm install @huggingface/transformers
```

```js
// models/ner.js
import { pipeline } from "@huggingface/transformers";

let classifier = null;

export async function loadNER() {
  if (classifier) return classifier;
  classifier = await pipeline("token-classification", "openai/privacy-filter", {
    device: "webgpu",
    dtype: "q4",
  });
  return classifier;
}

export async function redactText(text) {
  const clf = await loadNER();
  const spans = await clf(text);
  let out = text;
  for (const span of spans.reverse()) { // reverse so earlier offsets don't shift
    out = out.slice(0, span.start) + `[REDACTED:${span.entity_group}]` + out.slice(span.end);
  }
  return out;
}
```

`device: "webgpu"` is what triggers the WebGPU backend inside transformers.js, it falls back to WASM automatically and silently if WebGPU isn't available, worth logging which one you actually got during testing so you're not surprised by latency numbers later.

### Model loading UX

Both models are lazy-loaded on first use, not on extension install or page load, so the side panel opens instantly. The status dot next to each model name in the panel goes grey (not loaded) → amber (loading) → green (ready) → red (failed), driven by wrapping each `load*()` call with a status message posted back to the panel.

## 3.10 Testing the models and tools locally, before the server exists

This is the point of the **Test** buttons on every model row and every tool row in the panel: prove each piece works in isolation, on real pages, before wiring in the agent loop or touching the network. None of this needs the server running.

**Model test buttons:**

- **Test HaS** — captures the current visible tab, runs it through the segmentation model, draws the redacted result straight into the `#preview-img` element in the panel. You're checking two things: does it find sensitive regions at all, and are the masks aligned to the right pixels once scaled back up from the 640x640 inference size to the real frame size.
- **Test NER** — grabs `document.body.innerText` from the active tab via the content script, runs it through `redactText`, dumps original vs redacted side by side into the log. Checking recall (did it catch the planted email/phone in the test page) and that it isn't over-redacting ordinary text.

**Tool test buttons**, one per entry in the tool schema (section 3.7), each wired directly to the content-script/CDP implementation with a hardcoded or prompted argument, no model or server involved:

- **get_page_state** — runs the DOM walk, prints the returned element list (ref, role, label) to the log. Confirms ref ids are stable and sensitive fields are already redacted in the output.
- **read_element** — prompts for a ref id from the last `get_page_state` call, prints its redacted value.
- **click** — prompts for a ref id, dispatches the click via the content script, logs success/failure.
- **type** — prompts for a ref id and a string, types it in, logs the result.
- **scroll** — scrolls the active tab by a fixed amount, no argument needed.
- **screenshot** — same path as Test HaS but exercised as the actual `screenshot` tool implementation, not a standalone call, so you're testing the real code path the agent will use later.

Each test button calls the exact same function the background service worker will call once the server starts issuing tool calls. There's no separate "test version" of the logic, the button is just a manual trigger for the same code path, which means once every button works the agent loop has nothing left to prove except the model's own decision-making.

Suggested order for today: get the two model test buttons green first (they're the parts that involve new dependencies and are most likely to break), then work down the tool list top to bottom, since `get_page_state` produces the ref ids the rest of the tools need as input.

## 4. Server architecture

The server is a thin agent loop, not a custom pipeline. It does normal tool-calling against `deepseek-v4-flash-vision-exp` (OpenAI-compatible Chat Completions or Anthropic-compatible `/messages`, either works, DeepSeek supports both).

Loop:

1. User gives a task in the side panel ("fill out this form", "find the checkout button and click it").
2. Server sends the task plus the current redacted screenshot to the model, with the tool schema above attached.
3. Model replies with either a final answer or a tool call.
4. Server relays the tool call to the extension's background service worker over the open connection.
5. Extension executes it (DOM walk or CDP, depending on the tool), redacts anything sensitive in the result, sends the result back.
6. Server appends the tool result to the conversation and calls the model again. Repeat until the model returns a final answer or a max-turn limit is hit.

DeepSeek's vision input caps each image at 384 tokens, so we do not send a screenshot on every single turn if the model just asked for `read_element` on plain text, we only attach a fresh screenshot when the model actually asked for one via the `screenshot` tool or at loop start. This keeps token cost and latency down and lines up with the earlier decision to only send DOM/image data on demand rather than every turn by default.

Known gap worth stating plainly: `deepseek-v4-flash-vision-exp` is cloud-hosted only right now, no open-weight release. The problem statement allows cloud-hosted models during the hackathon itself, so this is fine for the demo, but if the eval specifically rewards fully offline-deployable server stacks, we note this as a documented tradeoff rather than pretend otherwise. A same-shaped fallback (self-hosted Qwen2-VL with tool calling) is a drop-in swap later since the tool contract doesn't change.

## 5. Data flow, end to end

```
[tab] → captureVisibleTab → [HaS + ONNX Runtime Web/WebGPU] → redacted PNG
[tab] → content script DOM walk → [openai/privacy-filter NER] → redacted element list
                                          |
                                   background service worker
                                          |
                                 server agent loop (DeepSeek V4 Flash Vision)
                                          |
                                    tool call decision
                                          |
                              background service worker dispatches
                                          |
                      content script executes (click/type/scroll) or
                        chrome.debugger executes (CDP-level input)
                                          |
                                 redact any resulting text
                                          |
                                 tool result → back to server
```

## 6. Mapping to the evaluation metrics

- **Accuracy of visual context from screen (25%).** Comes from the accessibility-tree-first approach for structure, HaS for privacy-relevant regions, and choosing a capable VLM (DeepSeek V4 Flash Vision benchmarks close to Opus 4.8 on agent/visual tasks) for the reasoning step.
- **Recall/precision for PII detection (20%).** Layered detection: deterministic DOM-type rules first (free, perfect precision on structured fields), NER model for unstructured text, HaS segmentation for visual PII. Layering catches more than any single method alone.
- **Precision of redaction (20%).** We don't try to detect-then-strip from an already-serialized payload, we redact before serialization. Structured fields never get put into a string in the first place. This makes precision closer to deterministic for the largest category of leaks (password fields, labeled financial fields).
- **Client-side resource utilization (20%).** WebGPU for both local models, FP16-quantized HaS checkpoint, viewport-only capture instead of full-page, on-demand DOM state instead of per-turn, and per-call `chrome.debugger` attach/detach instead of holding it open.
- **End-to-end latency (15%).** DOM walk is near-free and is the default path; screenshots and CDP calls only happen when actually needed; tool calls only send a fresh image when the model asks for one.

## 7. Build order for today

1. Extension skeleton: manifest v3, background service worker, `captureVisibleTab` wired up and confirmed working end to end into a canvas.
2. Check xuanwulab's HF org for an existing ONNX/quantized HaS export before doing it by hand.
3. Export HaS to ONNX (opset 12, NMS baked in, simplify), convert to FP16.
4. Load the FP16 ONNX model in-browser via ONNX Runtime Web with the WebGPU execution provider, run it on one captured frame, confirm masks decode and land in the right place.
5. Wire up `openai/privacy-filter` via transformers.js on real DOM text (reuse the reference demo's NER call shape).
6. Lock the tool schema (section 3.7) as a shared file both sides import, before either side goes further.
7. Content script DOM walker: build the accessibility summary, tag sensitive fields by type, wire `get_page_state`/`read_element`.
8. `chrome.debugger` CDP path for `click`/`type`, attach-per-call, detach immediately after.
9. Server stub: DeepSeek V4 Flash Vision, 2-3 tools wired (`get_page_state`, `click`, `type`), prove one trivial task closes the loop end to end (e.g. "click the login button").
10. Once the loop closes, add the remaining tools (`scroll`, `navigate`, `screenshot`, `read_element`) and tighten redaction coverage across both channels.

## 8. Open items to settle before demo day

- INT8 vs FP16 for HaS: decide after seeing real latency numbers on target hardware, not in the abstract.
- Whether to distill down to a smaller YOLO11 backbone if the current checkpoint turns out heavier than expected.
- Fallback VLM (Qwen2-VL, self-hosted) in case DeepSeek's experimental endpoint has uptime issues during the actual demo, given it's explicitly labeled experimental.
- Max-turn cap and timeout handling for the agent loop, so a confused model doesn't loop forever on stage.
