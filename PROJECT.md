# Visual Guard — Privacy Agent

A Chrome Manifest V3 extension that lets a cloud language model operate the browser without ever seeing raw sensitive data. The extension reads the current tab, redacts personally identifiable information on the device, and only then sends the result to a chat model. The model replies with tool calls. The extension executes those calls (click, type, scroll, navigate) and redacts every result before the next turn.

The product name in the manifest is **Visual Guard — Privacy Agent**. The package name is `privacy-agent-extension`, version `0.1.0`.

The side panel is an Apple-style Liquid Glass surface that refracts a live capture of the tab behind it. Under that surface is a real agent: local vision and text models, a tool contract, and an OpenAI-compatible chat loop.

---

## What problem it solves

A browser agent that can click, type, and read the page is also an agent that can leak passwords, card numbers, names, faces, and screenshots. Visual Guard splits the work:

1. **On the device**, two models plus deterministic rules strip sensitive pixels and sensitive text.
2. **Off the device**, a chat model sees only placeholders such as `[EMAIL]`, `[PASSWORD]`, and `[CARD]`, plus screenshots whose sensitive regions have already been painted over.
3. **Back on the device**, the extension performs the action the model asked for, then redacts whatever the page returned.

The cloud model never receives a raw password field, a raw card number, or an unmasked screenshot. If the vision model cannot produce a verified mask, the frame is withheld entirely and replaced with a "FRAME WITHHELD" image.

---

## Tech stack

| Layer | Choice | Why it is there |
|---|---|---|
| Extension | Chrome Manifest V3, service worker, content scripts, side panel | Persistent agent UI that does not close when focus leaves it |
| UI | Custom Liquid Glass CSS + SVG filters, no framework | Side panel is a small surface; React would add weight for no gain |
| Bundler | Vite 6, `base: "./"`, root `src/` | Builds the side panel into `dist/` and copies `public/` |
| Package manager | Bun 1.4 | Scripts (`diagnose`, smoke tests, proxy launcher) run under Bun |
| Text PII | `openai/privacy-filter`, transformers.js 4.x, dtype `q4f16`, WebGPU | Token classification of names, emails, phones, addresses, secrets |
| Visual PII | HaS (`xuanwulab/HaS_Image_0209`), YOLO11-seg, FP16 ONNX, ONNX Runtime Web 1.29, WebGPU | Instance masks over faces, IDs, cards, screens, biometrics |
| Chat agent | OpenAI Chat Completions tool calling | `deepseek-v4-flash`, fallback `glm-5.3` |
| Upstream | AgentRouter (`https://agentrouter.org/v1`) via a local proxy | Chrome's TLS fingerprint is blocked by AgentRouter's WAF |
| Proxy fallback | Official DeepSeek API (`https://api.deepseek.com`) | If AgentRouter returns 405, the proxy remaps models to `deepseek-chat` |
| Proxy server | FastAPI + Uvicorn + the OpenAI Python SDK, port `8787` | Browser talks to localhost; the proxy talks to the cloud |
| Storage | `chrome.storage.local` for settings, `chrome.storage.session` for history | API key and conversation survive panel reloads within the browser session |

There is no general UI-detection model. Element roles, labels, and coordinates come from the DOM. A second vision model would rediscover what the accessibility tree already provides.

---

## Repository layout

```
SIH/
├── public/                      # Copied into dist/ as the extension root
│   ├── manifest.json
│   ├── background.js            # Service worker
│   ├── content.js               # Injected into every frame
│   ├── rules/agentrouter.json   # declarativeNetRequest User-Agent rewrite
│   ├── models/                  # Optional local weights; stripped from dist/
│   └── wasm/v129/               # ONNX Runtime WebGPU wasm (kept in the package)
├── src/                         # Vite source root
│   ├── sidepanel/               # Panel HTML, Liquid Glass, chat, agent wiring
│   ├── agent/                   # Chat client, tool schemas, agent loop, settings
│   ├── client/models/           # Live NER + HaS used by the extension
│   ├── models/                  # Older local-file NER/HaS path (diagnose / offline)
│   └── shared/tool-contract.js  # The single tool list both sides share
├── scripts/
│   ├── agent-proxy.py           # Local LLM proxy
│   ├── agent-proxy.js           # Bun launcher for the Python proxy
│   ├── download-models.js       # Pull openai/privacy-filter into public/models
│   ├── export-has.py            # Export HaS .pt → FP16 ONNX
│   ├── clean-dist.mjs           # Strip weights and duplicate wasm from dist/
│   ├── diagnose.js              # Model-file diagnostic
│   ├── smoke-agent.js           # Tool-calling smoke test via curl
│   └── smoke-test-ner.js
├── liquid-glass/                # Standalone glass prototype (not the shipped extension)
├── on-device-visual-perception-design.md
├── vite.config.js
└── package.json
```

`liquid-glass/` is the original optics prototype: its own manifest, a scripted chat, and a demo page. The shipped panel lives in `src/sidepanel/` and wires that same glass to the real agent in `agent-backend.js`.

---

## Architecture

Three Chrome contexts, plus one local process.

```
┌─────────────────────────────────────────────────────────────┐
│  Side panel  (src/sidepanel)                                │
│  Liquid Glass UI · chat · autonomy gate · redaction models  │
│  TextPrivacyModel (NER)   ImagePrivacyModel (HaS)           │
│  runAgentLoop()                                             │
└───────────────┬──────────────────────────▲──────────────────┘
                │ chrome.runtime messages  │ already-redacted
                ▼                          │ tool results
┌─────────────────────────────────────────────────────────────┐
│  Background service worker  (public/background.js)          │
│  Tabs, capture, debugger, chat proxy, tool dispatch         │
└───────────────┬─────────────────────────────────────────────┘
                │ chrome.tabs.sendMessage (per frame)
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Content script  (public/content.js)  · all frames          │
│  DOM walk · stable refs · click / type / scroll / submit    │
└─────────────────────────────────────────────────────────────┘

Side panel  ──HTTP──►  http://127.0.0.1:8787/v1
                              │
                              ▼
                       scripts/agent-proxy.py
                         ├─ AgentRouter
                         └─ DeepSeek official (if WAF blocks)
```

### Side panel

`sidepanel.html` is the Vite entry. `sidepanel.js` only imports the glass modules; behavior lives in the modules they pull in.

| Module | Job |
|---|---|
| `refraction.js` | Ray-traces a convex-squircle glass slab, bakes a displacement map, builds the SVG filter |
| `glass-cover.js` | Live tab capture, black-band crop, cover geometry |
| `glass-shell.js` | Capture lifecycle, sliders, tab following, theme, and the agent runner hookup |
| `glass-chat.js` | Message list, streaming parts, approval gates, autonomy chip |
| `glass-slider.js` | Pointer and keyboard slider used by the optics controls |
| `agent-backend.js` | Connects the chat to models, tools, and `runAgentLoop` |

The panel has two views, switched by a segmented control and stored in `chrome.storage.local` under `lg-view`:

- **Chat.** Composer, message thread, autonomy chip (`suggest` / `confirm` / `auto`).
- **Controls.** Capture status, optics sliders, model select, API key, base URL, recapture and stop.

### Background service worker

`public/background.js` is plain JavaScript, not bundled by Vite. It is the only context that can use `chrome.tabs`, `chrome.debugger`, `chrome.scripting`, and `captureVisibleTab`.

Message types it handles:

| Message | What happens |
|---|---|
| `GET_ACTIVE_TAB` | Returns the focused tab's id, title, url, favicon |
| `GET_TABS` | Lists `http(s)` tabs for the `list_tabs` tool |
| `AGENT_CHAT` | POSTs the chat body to `{baseUrl}/chat/completions` with the API key |
| `PROXY_HEALTH` | GETs the proxy `/health` endpoint |
| `CAPTURE_VISIBLE_TAB` | PNG of the visible viewport via `chrome.tabs.captureVisibleTab` |
| `SCAN_PAGE` | Walks every frame and returns a merged page state |
| `APPLY_TEXT_REDACTION` | Asks the top frame to replace detected spans in the live DOM |
| `EXECUTE_TOOL` | Runs one tool against a chosen tab |

The toolbar click opens the side panel for that tab and sends `lg:activate` so the glass can re-acquire capture. `openPanelOnActionClick` is set to `false` because the click handler does the open itself; a `default_popup` is intentionally absent, or the icon would open a popup instead of the panel.

### Content script

`public/content.js` is injected at `document_idle` into **all frames** of every URL. It guards itself with `window.__visualGuardContentScript` so a reinjection does not double-register.

It keeps a `WeakMap` from DOM node to a stable ref (`ref_1`, `ref_2`, …) and a `Map` back from ref to node. Refs survive across turns for as long as the node does. The background prefixes them with the frame id, so the agent sees `f0_ref_3` for the top frame and `f12_ref_1` for an iframe. `parseFrameRef` splits that prefix before the message is sent into the frame.

---

## How a page is read

`gatherPageState` in the background:

1. Ensures the content script is present (re-injects with `chrome.scripting.executeScript` if a ping fails).
2. Lists frame ids with `chrome.scripting.executeScript({ allFrames: true })`.
3. Asks each frame for `GET_PAGE_STATE`.
4. Prefixes every element ref with `f{frameId}_`.
5. Merges elements and concatenates readable text, capped at 10,000 characters.

Inside a frame, `collectElements` queries a fixed interactive selector (buttons, links, inputs, textareas, selects, labels, headings, and common ARIA roles). Invisible nodes are dropped. Each survivor is scored:

- In the viewport, near the visual center, scores higher.
- Radios, checkboxes, textboxes, headings, and buttons score higher than links and tabs.
- Nodes inside `nav`, `header`, `footer`, `aside`, or a sidebar score lower.
- Nodes inside `main` (or `#content`, `.quiz`, `.assessment`, …) score higher.
- Labels that look like quiz chrome ("question", "submit", "next") score higher; "cookie", "donate", "log in", "jump to" score lower.

The top 120 scored elements are returned. The side panel then re-ranks them again (`usefulElements`) and keeps about 64 for the agent or 100 for a manual scan.

Each element is serialized as:

```json
{
  "ref": "ref_4",
  "role": "textbox",
  "tag": "textarea",
  "label": "Message",
  "value": "",
  "checked": null,
  "sensitive": false,
  "bounds": { "x": 120, "y": 640, "width": 480, "height": 40 }
}
```

`bounds` are converted to top-window coordinates by walking `frameElement.getBoundingClientRect()` up the frame chain.

Accessible names follow the same sources Chrome uses: `aria-label`, `aria-labelledby`, associated `<label>`, then `placeholder`, `title`, `alt`, and text content. Radio and checkbox labels also look at the wrapping `<label>` and the next sibling.

Readable body text (`textForLocalModel`) walks text nodes under `main` first, skips `script`, `style`, `noscript`, and `svg`, and stops at 8,000 characters per frame.

### Deterministic sensitive fields

Before any model runs, `sensitiveKind` classifies an input from its `type`, `autocomplete`, and `name`:

| Signal | Kind | Value sent onward |
|---|---|---|
| `type=password`, or name/autocomplete matching password, passcode, pin | password | `[REDACTED:PASSWORD]` |
| autocomplete or name matching `cc-`, card, credit | card | `[REDACTED:CARD]` |
| `type=email`, or a name matching email | email | `[REDACTED:EMAIL]` |
| token, secret, api key | secret | `[REDACTED:SECRET]` |

`typeElement` refuses to type into password, card, or secret fields. The model can see that a password box exists. It cannot read the value, and it cannot write into it.

---

## Text redaction

The live class is `TextPrivacyModel` in `src/client/models/text-redactor.js`.

Two layers run on every string:

1. **Deterministic regular expressions**, always, even if the neural model is still downloading:
   - Email: standard local-part `@` domain pattern.
   - Card: 13–19 digits with optional spaces or dashes.
   - Phone: a digit run of at least about 8 characters, optional leading `+`.
   - Secret: tokens shaped like `sk-…`, `pk-…`, or `api_…` of length 12+.
2. **`openai/privacy-filter`** through transformers.js, when the classifier is already loaded. The agent path does not wait for the download. Early turns use the regex layer; a background warm starts 2.5 seconds after an agent run begins.

Model settings:

- Pipeline: `token-classification`
- Device: `webgpu` (no silent CPU fallback; missing WebGPU marks the model unavailable)
- Dtype: `q4f16`
- Aggregation: `simple`
- Remote models allowed, browser cache on, so weights come from Hugging Face and stay in IndexedDB / the browser cache
- Confidence floor in the client path: `0.45`
- Spans longer than 35% of the text (and at least 48 characters) are dropped unless the kind is email, phone, card, password, or secret — this stops the model from blanking a whole paragraph

Labels are mapped onto a closed set. Anything outside the set is ignored and never becomes page text:

`NAME`, `EMAIL`, `PHONE`, `ADDRESS`, `DATE`, `URL`, `CARD`, `PASSWORD`, `SECRET`, `ID`

Overlapping spans are merged. Higher-scoring kinds win ties. Replacement walks the string from the end so earlier offsets do not shift.

Placeholder form is `[EMAIL]`, not the original characters.

Manual scans can also push redactions back into the live DOM (`APPLY_TEXT_REDACTION`). The content script replaces text nodes only when the match has safe word boundaries, and a `MutationObserver` re-applies the queue if the page rewrites the node. The agent path skips this live rewrite: mutating Discord-style composers while the agent is reading them is expensive and unnecessary, because the model already receives the redacted copy.

`src/models/ner.js` is an older sibling used for offline checks. It forces `local_files_only`, a `0.9` confidence floor, and the transformers.js wasm at `wasm/v126`. The extension does not import it.

---

## Image redaction

The live class is `ImagePrivacyModel` in `src/client/models/image-redactor.js`.

Capture is the **visible viewport only**, PNG, via `chrome.tabs.captureVisibleTab`. Full-page stitching is deliberately not done: frame size and inference cost stay fixed per turn.

### The HaS model

HaS is a YOLO11 instance-segmentation network trained on 21 privacy categories:

`face`, `fingerprint`, `palmprint`, `id card`, `travel permit`, `passport`, `employee badge`, `license plate`, `bank card`, `physical key`, `receipt`, `shipping label`, `official seal`, `whiteboard`, `sticky note`, `mobile screen`, `monitor screen`, `medical wristband`, `QR code`, `barcode`, `paper`

The published checkpoint is Ultralytics FP32 (`.pt`, about 133 MB). `scripts/export-has.py` downloads `xuanwulab/HaS_Image_0209_FP32`, exports ONNX at opset 12 with `simplify=True`, `imgsz=640`, `half=True`, and NMS baked into the graph. The browser-ready file is hosted at:

`https://huggingface.co/kookoocoder/visual-guard-models/resolve/main/has/model.onnx`

Override that URL at build time with `VITE_HAS_MODEL_URL`.

### Load path

1. Look in the Cache API (`visual-guard-models-v1`). Cache keys use a fake HTTPS origin (`https://visual-guard-cache.invalid/…`) because Cache Storage rejects `chrome-extension://` requests.
2. On a miss, stream the ONNX from Hugging Face, yielding to the UI about every 80 ms so the panel stays responsive, and report percent progress.
3. If the download fails, fall back to a packaged `models/has/model.onnx` if one is present.
4. Create an ONNX Runtime WebGPU session (`graphOptimizationLevel: "all"`). The wasm runtime is `public/wasm/v129/ort-wasm-simd-threaded.asyncify`.

Input name is read from the session (`inputNames[0]`), not hardcoded.

### Inference

The frame is drawn onto a 640×640 canvas (stretched, not letterboxed, in the client path), converted to a float32 NCHW tensor in `[0, 1]`, and run.

`decodeOutput` accepts two layouts:

- **NMS export** (what we ship): each row is `[x1, y1, x2, y2, score, class, mask coefficients…]`.
- **Raw YOLO head** (if a future export drops NMS): objectness, class scores, and `cx, cy, w, h` boxes.

Score threshold is `0.32`. Boxes smaller than 1% of the frame on either axis are dropped. At most 40 detections are kept. Normalized coordinates in `[0, 1]` are what the drawer uses.

Instance masks are `sigmoid(coefficients · prototypes)` on the 4-D prototype tensor, thresholded at `0.5`. Each mask is composited with `source-in` and filled with near-opaque navy (`rgba(9, 16, 30, 0.98)`). A lime stroke and a `MODEL MASK · {label}` caption are drawn on the preview so a human can see what was caught. The chat model does not receive the raw pixels; `executeAgentTool("screenshot")` returns only the mode, detection count, labels, scores, and elapsed time, plus an explicit note that the viewport was masked on-device.

### Fail closed

If the session throws, or if it returns zero detections, the function does **not** send the original PNG. It returns a solid placeholder that says `FRAME WITHHELD` / `Visual model did not produce a verified result`. A page with nothing sensitive on it will therefore also withhold the frame. That is a precision choice: an empty detection list is treated as "the model did not verify the frame," not as "the frame is safe."

`src/models/has.js` is the offline sibling. It letterboxes onto 640 with a `#727272` pad (Ultralytics-style), decodes a fixed 38-wide row (`4 box + score + class + 32 coefficients`), crops masks to the box in 160×160 mask space, and drops detections that cover more than 70% of the content area so a "wall" false positive cannot black out the page. The live client path does not apply that 70% filter.

After a screenshot, HaS schedules its own unload in 12 seconds (5 seconds on error) so the NER model can reclaim GPU memory.

---

## Memory manager

`src/client/models/memory-manager.js` exists because NER and HaS together will thrash a laptop GPU.

- `withLoadLock` serializes loads. The two models never initialize at the same time.
- `evictOthers(keepId)` unloads every resident except the one about to load.
- A resident is evicted after **90 seconds** idle (`DEFAULT_IDLE_MS`).
- If the panel is hidden, the idle window drops to **15 seconds**.
- `pagehide` evicts everything.
- If `PressureObserver` exists, a `serious` reading keeps only the most recently used model; a `critical` reading evicts all of them and shortens the idle window to 5 seconds.

The side panel does **not** warm either model when it opens. That warm-on-open was what made machines lag. Models load on first scan, first screenshot, or (for NER) a delayed background warm during an agent run.

---

## Tool contract

`src/shared/tool-contract.js` is the list. `src/agent/openai-tools.js` turns it into the OpenAI `tools` array the chat API expects. Unknown tool names from the model are rejected inside the loop and returned as `{ ok: false, error }`.

| Tool | Category | Arguments | Behavior |
|---|---|---|---|
| `list_tabs` | observe | none | `http(s)` tabs: id, title, url, favicon, active, window id. Titles and URLs are redacted again before they leave |
| `get_page_state` | observe | optional `tab_id`, optional `reason` | Redacted accessibility summary. Omitting `tab_id` uses the active tab |
| `read_element` | observe | `selector_ref`, optional `tab_id` | One element's redacted label and value |
| `click` | act | `selector_ref`, optional `tab_id` | Scroll into view, focus, pointer events, `.click()`. If a checkbox or radio stays unchecked, it is set and `input`/`change` are fired. New tabs opened within 350 ms are returned as `openedTabs` |
| `type` | act | `selector_ref`, `text`, optional `tab_id` | Types into an editable node. Password, card, and secret fields throw. Content editable uses `execCommand("insertText")` so React-style listeners see a real edit; inputs fall back to setting `.value` and dispatching `input`. If the DOM path fails for a reason other than "blocked" or "not editable", Chrome DevTools Protocol `Input.insertText` is used after select-all and backspace |
| `press_key` | act | `selector_ref`, `key` ∈ Enter/Escape/Tab, optional `tab_id` | Synthetic keyboard events first. If the page ignores them, `chrome.debugger` sends trusted `rawKeyDown`/`keyUp` (protocol `1.3`) and detaches immediately. Enter on a non-empty composer is subject to the duplicate-submission guard |
| `submit` | act | `selector_ref`, optional `tab_id` | Finds a visible Send/Submit control: `button[type=submit]`, `aria-label="Send"`, `[data-testid="send"]`, or a `data-icon="send"` ancestor. Clicks that, not the composer. Duplicate guard applies to the composer text |
| `scroll` | act | `direction` up/down, optional `amount_px` (default 320), optional `tab_id` | Scrolls the top frame and every child frame. The scroll target is the element under the viewport center, walking up to the first scrollable ancestor |
| `navigate` | act | `url`, optional `tab_id` | `chrome.tabs.update`. Only `http:` and `https:` |
| `screenshot` | observe | optional `reason` | Viewport PNG, then HaS. The model receives a summary, not pixels |

`tab_id` is stripped before `executeTool` so it is routing metadata, not a content-script argument.

### Duplicate submission guard

`claimSubmission` fingerprints composer text (FNV-1a over a lowercased, whitespace-collapsed string) and stores the last 50 fingerprints per session for 30 minutes. A second `submit` or Enter of the same text in the same tab returns:

`Duplicate submission blocked: this exact message was already submitted recently.`

The system prompt tells the model to stop retrying when it sees that string.

### Chrome DevTools Protocol

`chrome.debugger` is attached per call and detached in a `finally`, including on failure. Chrome shows a "this extension is debugging this browser" banner only while attached. Trusted input is the fallback for pages that ignore synthetic DOM events (common in chat composers). CDP is not used to read the accessibility tree; the content-script walk is the default because it is near-instant and covers most pages. The design doc describes `Accessibility.getFullAXTree` as an option; the shipped code does not call it.

### What the model is told

`SYSTEM_PROMPT` in `src/agent/config.js` is strict:

- Operate only on already-redacted state. Placeholders are not values. Never type `[NAME]` or invent the hidden text.
- Do not invent refs. Call `get_page_state` before acting. After an action that can change the DOM, call it again.
- For cross-tab work, `list_tabs` first, then `get_page_state(tab_id)` only on the relevant tabs.
- An explicit user request to send, post, or submit is authorization. Do not ask again.
- If `click` returns `openedTabs`, continue in the new tab. Never reuse a ref with a different `tab_id`.
- Page state is a snapshot of what is loaded, not a full history. Do not claim rankings, counts, or delivery status the evidence does not show.
- Typing `@Name` is not a confirmed mention. Select the suggestion and verify it.
- Do not treat an empty field as proof of success, and do not resend because history has scrolled away.
- Final answers are plain text. No Markdown. The panel also runs `plainText()` to strip headings, fences, and emphasis if the model ignores that.

---

## Agent loop

`runAgentLoop` in `src/agent/agent-loop.js` is a standard tool-calling loop.

Defaults (`AGENT_CONFIG`):

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| Upstream (documented, not called from Chrome) | `https://agentrouter.org/v1` |
| Docs URL | `https://co.agentrouter.org/v1` |
| Model | `deepseek-v4-flash` |
| Fallback model | `glm-5.3` |
| Max turns | 200 |
| Max tokens | 2048 |
| Temperature | 0.2 |
| User-Agent | `QwenCode/0.2.0 (linux x64)` |

Each turn:

1. Compact tool results older than the latest 6, if a payload is longer than 800 characters, down to `{ compacted: true, action, tab_id, title, error }`. Long sessions would otherwise blow the context window.
2. `POST /chat/completions` with `tool_choice: "auto"` and the full tool list.
3. If the HTTP status is 402, 429, or 503, and the fallback model has not been used yet, switch to `glm-5.3` and retry that turn once.
4. If the assistant message has no `tool_calls`, that text is the final answer.
5. Otherwise each tool call is executed, JSON-serialized, and appended as a `role: "tool"` message. `reasoning_content` is preserved on the assistant message when the provider sends it.
6. AbortSignal cancellation throws `Agent run cancelled.`
7. Hitting 200 turns returns a truncated final answer instead of looping forever.

Events emitted to the UI: `start`, `model_request`, `model_response`, `model_error`, `model_fallback`, `tool_call`, `tool_result`, `final`.

The chat client (`AgentRouterClient`) prefers `chrome.runtime.sendMessage({ type: "AGENT_CHAT" })` so the service worker performs the fetch (host permissions, and the declarativeNetRequest rule can set the User-Agent). A direct `fetch` exists for non-extension runs. Connection-refused errors tell the user to start `bun run agent-proxy`. HTML or 405 responses are explained as a WAF block, not a generic network error.

If the configured base URL contains `agentrouter.org`, the panel rewrites it to the localhost proxy before the run. Chrome cannot complete that TLS handshake; the WAF rejects the browser fingerprint.

### Settings

`loadAgentSettings` / `saveAgentSettings` use `chrome.storage.local`:

| Key | Meaning |
|---|---|
| `agentrouterApiKey` | Bearer token. The Controls field is `type=password` |
| `agentModel` | `deepseek-v4-flash` or `glm-5.3` |
| `agentBaseUrl` | Usually `http://127.0.0.1:8787/v1` |

Build-time defaults come from Vite env (`VITE_AGENTROUTER_API_KEY`, `VITE_AGENT_MODEL`, `VITE_AGENTROUTER_BASE_URL` in `.env.local`, which is gitignored). An env base URL is used only when it points at `127.0.0.1` or `localhost`. A stored key wins over the env key.

Conversation messages (everything after the system prompt) are kept in `chrome.storage.session` under `visualGuardAgentHistory`, so a panel reload in the same browser session continues the thread, and a browser restart does not.

### Autonomy

The composer chip cycles three modes. `createRunner` wraps `executeAgentTool`:

| Mode | Chip label | Effect |
|---|---|---|
| `suggest` | Suggest only | Every tool returns `{ ok: false, error: "Suggest only mode did not run this action." }` |
| `confirm` | Confirm each step | Default. Each tool opens an approval card (name, JSON arguments, impact line). Deny stops that step |
| `auto` | Execute end to end | Tools run immediately |

Stop aborts the `AbortController` on the loop. Regenerate re-runs the last user text. Errors render in the thread with the conversation preserved.

The chat renders an agent turn as ordered parts, in the AG-UI style:

- **reasoning** — a `<details>` that stays open while streaming ("Thinking…") and collapses to "Reasoning"
- **tool** — name, argument JSON, result, status, elapsed milliseconds
- **text** — the answer, as plain text
- **approval** — Approve / Deny, returns a promise
- **error** — inline failure

User bubbles are accent-tinted and right-aligned. Agent bubbles are neutral and left-aligned. Consecutive messages from the same author group: tighter gap, flattened corner, header row only on the first of the group.

---

## Local proxy

`bun run agent-proxy` launches `.venv/bin/python scripts/agent-proxy.py` on `127.0.0.1:8787`.

For each `POST /v1/chat/completions`:

1. **AgentRouter**, 8 second timeout, using the request's bearer token or `AGENTROUTER_API_KEY` / `VITE_AGENTROUTER_API_KEY` / `PI_GATEWAY_API_KEY` from `.env.local`. The model name is forwarded as-is (`deepseek-v4-flash`, `glm-5.3`).
2. If that call looks like a WAF block (HTTP 405, or a body matching `waf` / `doctype` / `unauthorized client` / `blocked`), AgentRouter is disabled for **5 minutes**.
3. **DeepSeek official**, 90 second timeout, key `DEEPSEEK_API_KEY` or `VITE_DEEPSEEK_API_KEY`, or the same bearer. Model names remap:

   | Requested | Sent to DeepSeek |
   |---|---|
   | `deepseek-v4-flash`, `deepseek-v4f` | `deepseek-chat` |
   | `glm-5.3`, `glm-5.2` | `deepseek-chat` |
   | anything starting with `glm`, `gpt`, or `claude` | `deepseek-chat` |

The response includes `_proxy: { upstream, model }` so the panel log can show which provider actually answered. `stream` is forced off. CORS is open because the caller is an extension page.

`GET /health` and `GET /v1/health` report whether each key is configured, without printing the key. `GET /v1/models` lists the three ids the UI and the proxy understand.

`public/rules/agentrouter.json` still rewrites `User-Agent` to `QwenCode/0.2.0 (linux x64)` on requests to `agentrouter.org`. That rule matters only if something in the extension talks to AgentRouter directly. The intended path is the proxy. The background `AGENT_CHAT` handler also sets that User-Agent itself.

Environment variables the proxy reads (all optional except that at least one upstream key must exist):

`AGENT_PROXY_PORT` (default 8787), `AGENTROUTER_BASE_URL`, `DEEPSEEK_BASE_URL`, and the key names above.

---

## Liquid Glass

The panel cannot sample tab pixels with `backdrop-filter`. A side panel is a separate compositing surface. `captureVisibleTab` is also capped by Chrome at about two stills per second. So the backdrop is a live `MediaStream`:

```
chrome.tabCapture.getMediaStreamId({ targetTabId })
  → getUserMedia({ video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId } } })
  → <video> behind the glass
```

Audio is not requested, so the tab's sound is unchanged. `chrome://`, `edge://`, `about:`, `devtools:`, and extension pages are blocked and not captured.

Chrome only grants `getMediaStreamId` immediately after the extension is invoked on that tab (the same rule as `activeTab`). The toolbar click is that invocation. The panel follows `tabs.onActivated` and re-acquires; if Chrome refuses, the status reads that a click is needed and the previous frame stays up instead of flashing black. In-tab navigation does not drop the stream; the crop is recomputed.

### The black band

Chromium latches capture resolution once, at `FIXED_RESOLUTION`, using the tab size at start. Resizing the side panel changes the tab width, the capturer letterboxes, and a black band appears on the right. The band width matches the panel size at capture time. It is a size mismatch, not the panel being filmed.

`glass-cover.js` fixes it in three layers:

1. Read `innerWidth`, `innerHeight`, and device pixel ratio from the tab and pass them as min/max constraints on `getUserMedia`. If the constrained request fails, retry unconstrained.
2. Crop from the viewport ratio when the mismatch is over 2%: `fraction = viewport.w / (frameWidth / dpr)`.
3. Measure the band from pixels: draw the frame to a 160 px canvas and walk columns in from the right until luminance exceeds 8. An all-black frame (more than 30% of columns "dark") is rejected so a genuinely dark page is not cropped away.

Whichever of (2) and (3) crops more is used. `coverBox()` then scales with `Math.max` so the frame always covers the panel (no gap). Layout reruns on `loadedmetadata`, the track `resize` event, a `ResizeObserver` on the stage, and a 1.4 s poll while capturing, because the latched format can drift.

### The optics

`refraction.js` does not use the common `d = f' / (1 + f'²)` curve. That curve is `½ sin 2θ`: it peaks at 45° and falls to zero at the rim, which is the opposite of real glass.

The slab profile is a convex squircle, `f(x) = (1 - (1 - x)^4)^(1/4)`, with BK7 crown glass index `n = 1.5168`:

```
θs(x) = atan f'(x)
θr(x) = asin(sin θs / n)
t(x)  = T0 + B · f(x)
d(x)  = t(x) · tan(θs − θr) · (1 − R)
```

Displacement peaks at the rim and decays inward. The vector points inward (a convex slab magnifies). The map is encoded as R = X, G = Y, 128 = neutral, in sRGB (`color-interpolation-filters="sRGB"` is required; linearRGB drifts the neutral point). It is baked at the element's real size, up to 1024 px, so the bezel stays a constant pixel width. `feImage` uses a base64 data URL because external URLs fail inside a zero-size SVG. Firefox and Safari ignore `url()` inside `backdrop-filter` and fall back to blur only.

Locked defaults, also the initial `data-value`s in the HTML: refraction `250` (slider max 400), blur `2`, tint `0.08`, fringe `0`, dim `0.4`. Saved settings override these.

The material is calibrated to a compressive transfer (`glass_L ≈ 0.58 · backdrop_L + 34`): it lifts blacks and compresses contrast. It is a partially transparent fill, not `mix-blend-mode: overlay` and not a dark scrim. Specular highlights are a measured ring (bright top and bottom, dark flanks), not a conic gradient.

Nested controls (buttons, pills, slider, scrollbars) do **not** use `backdrop-filter`. In Chromium, `filter`, `transform`, `opacity < 1`, or a parent backdrop-filter makes a descendant backdrop-filter sample nothing. Those controls fake the material with tint, an anisotropic bead rim (`inset` box-shadows at high alpha), a tight dark inner ring, and a 45° specular. The slider thumb is positioned with `left` rather than `translate`, for the same backdrop-root reason, and its lens is a radial-gradient normal map (`scale` negative on `feDisplacementMap`). The slider fill and thumb blob sit in an `feGaussianBlur` → alpha `feColorMatrix` (`0 0 0 16 -7`) → `feComposite atop` goo filter so they merge into one meniscus.

`prefers-reduced-transparency` drops refraction for a more opaque frost. `prefers-contrast: more` adds a solid border. `prefers-color-scheme` switches the `lg-dark` / `lg-light` token set. Agent text gets a text-shadow so it stays readable over a busy live capture; the Dim slider is the manual override.

---

## Permissions

From `public/manifest.json`. Minimum Chrome version is 116 (side panel and WebGPU).

| Permission | Used for |
|---|---|
| `sidePanel` | The agent UI |
| `activeTab` | Act on the tab the user invoked |
| `scripting` | Re-inject `content.js`, list frame ids |
| `storage` | Settings, agent history, submission fingerprints |
| `tabs` | List, activate, navigate, read titles and URLs |
| `tabCapture` | Live glass backdrop |
| `debugger` | Trusted key and text input, attach-per-call |
| `declarativeNetRequestWithHostAccess` | User-Agent rewrite toward AgentRouter |

Host permissions: `<all_urls>`, `https://agentrouter.org/*`, `http://127.0.0.1:8787/*`, `http://localhost:8787/*`, Hugging Face (`huggingface.co`, `hf.co`, and subdomains), and `https://cdn.jsdelivr.net/*`.

Content Security Policy for extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. Wasm eval is required by ONNX Runtime.

---

## Build, package size, and scripts

```bash
bun install
bun run dev          # Vite on 127.0.0.1, for UI work
bun run build        # vite build && node scripts/clean-dist.mjs
bun run preview
bun run diagnose     # bun scripts/diagnose.js
bun run smoke:agent  # tool-calling smoke test (needs an API key)
bun run agent-proxy  # Python proxy via .venv
```

Vite config:

- `root` is `src/`
- `publicDir` is `public/`
- `envDir` is the repo root (so `.env.local` is visible)
- `base` is `./` (extension pages are not served from `/`)
- The only Rollup input is `src/sidepanel/sidepanel.html`
- Output is `dist/`, emptied each build

`clean-dist.mjs` then deletes `dist/models` (weights are downloaded on first use), `dist/wasm/v126` (NER and HaS share the v129 runtime), and any stray `ort-wasm*` files Vite dropped into `assets/`. After that, `dist/` is on the order of **25 MB** (one ORT wasm) instead of about 1 GB of weights.

Load the extension from `chrome://extensions` → Developer mode → Load unpacked → the `dist/` folder. Click the toolbar icon on a normal web tab.

Optional offline weights, for diagnose scripts only:

```bash
bun scripts/download-models.js    # openai/privacy-filter → public/models/…
uv run scripts/export-has.py      # HaS .pt → public/models/has/model.onnx
```

`.gitignore` excludes `node_modules/`, `.venv/`, `dist/`, `.env`, `.env.local`, `*.pem`, `agent-secrets.json`, ONNX weights, tokenizer JSON, and the HaS `.pt` cache.

---

## Data flow, one turn

1. User types a task and presses Enter. In `confirm` mode, nothing touches the page yet.
2. The panel checks the proxy `/health` when the base URL is localhost. A down proxy fails the run with instructions to start it.
3. Settings are saved. NER warm is scheduled, not awaited.
4. The loop sends the system prompt, prior session messages, and the new user text.
5. The model calls `get_page_state`. The background walks every frame. Sensitive input values are already `[REDACTED:…]`. Labels and body text pass through regex redaction, and through NER if it is ready. The tool result is JSON of refs, roles, labels, and redacted text. No `textForLocalModel` field is forwarded; keys matching `raw` or `textForLocalModel` are stripped in `redactToolResult`.
6. In `confirm` mode the approval card shows the next tool (`click`, `type`, …) before it runs. Deny returns an error tool result and the model has to adapt.
7. The content script acts. If a click opens a tab, `openedTabs` is included. Submit and Enter are fingerprinted.
8. The result is redacted again (deterministic pass on any string field whose name looks like label, value, text, title, or url) and appended to the conversation.
9. If the model calls `screenshot`, the viewport is captured, HaS masks it or the frame is withheld, and only a text summary goes back.
10. When the model returns text and no tool calls, that text is stripped of Markdown and shown as the answer. The message list, minus the system prompt, is written to session storage.

---

## What is intentionally not done

- **No raw path off the device.** Screenshot failure withholds the frame. Password, card, and secret fields cannot be typed into. Tool results drop raw-text keys.
- **No second vision model for buttons.** The DOM already has roles and coordinates.
- **No full-page screenshot.** Viewport only, so HaS cost does not grow with page length.
- **No long-lived debugger session.** Attach, act, detach.
- **No auto-load of both models at panel open.** One resident model, idle eviction, load lock.
- **No direct browser call to AgentRouter.** The WAF blocks Chrome. The proxy is the supported path.
- **No streaming tokens from the provider.** The proxy forces `stream: false`. The panel still reveals state turn by turn (planning, tool cards, then the answer) because each loop event is rendered as it arrives.
- **Weights are not in the extension package.** First run downloads them.

The design note `on-device-visual-perception-design.md` describes an earlier UI (native Chrome greys, per-tool Test buttons, a log pane) and a few mechanisms the code has since grown past (CDP accessibility-tree reads, letterbox preprocessing on the live path, a much smaller turn cap). Where that note and this file disagree, the source cited above is what runs.

---

## Evaluation intent

The design was written against a hackathon rubric. The mapping still describes the architecture:

| Criterion | How the project addresses it |
|---|---|
| Visual context from the screen | Accessibility tree for structure, HaS for privacy regions, a vision-capable chat model for decisions. Screenshots are optional and already masked |
| PII recall and precision | Three layers: DOM field type (perfect on structured inputs), regex, NER. Visual categories are a fourth layer on pixels |
| Redaction precision | Redaction happens before serialization. Structured secrets are never placed in a string. Unknown NER labels are dropped |
| Client resource use | WebGPU, quantized NER, FP16 HaS, viewport capture, on-demand page reads, one model resident, idle unload |
| End-to-end latency | DOM walk is the default. Screenshots and the debugger run only when a tool asks. The agent does not block on the first NER download |

---

## Security boundaries worth knowing

- The API key sits in `chrome.storage.local` and in `.env.local`. Neither is committed. The Controls field is a password input. The proxy health endpoint reports only whether a key is configured.
- `navigate` rejects non-http(s) URLs, so the model cannot open `javascript:` or `file:` URLs through that tool.
- Typing is blocked for password, card, and secret fields even if the model asks.
- Host access is `<all_urls>` because a browser agent that only works on one origin is not useful. That is a broad permission. The redaction boundary is what keeps page contents from becoming model context, not the host permission list.
- The debugger permission can, in principle, do more than insert text. The shipped calls are `Input.dispatchKeyEvent` and `Input.insertText`, attach-per-call, on the tab the tool addressed.
- Content scripts run in every frame of every page, including iframes. They only respond to extension messages. They do not phone home.
- Live tab capture follows the user-gesture rule. It cannot silently attach to a tab the user has not invoked the extension on.
